/** Isolated proof that a re-enhanced image can replace the one on its intake row (D145). Temporary local PostgreSQL only; no .env, no network.
 *  The tables are the few columns the function touches; the two image_versions checks are copied from Phase 3b word for word. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

const SCHEMA = `
create role anon; create role authenticated; create role service_role bypassrls;
create type image_kind as enum ('original', 'generated');
create table public.intake_files (id uuid primary key, agent_tag text, agent_note text, agent_sha256 text, phash text,
  reenhance_job_id uuid, reenhance_note text, last_error text, last_error_code text);
create table public.image_versions (id uuid primary key default gen_random_uuid(), intake_file_id uuid not null references public.intake_files (id),
  version_no integer not null, kind image_kind not null, storage_key text not null, thumb_key text, width integer, height integer,
  prompt_text text, model text, cost_usd numeric(12, 6), parent_version_id uuid, is_selected boolean not null default false,
  description_injected boolean, description_missing boolean, unique (intake_file_id, version_no),
  constraint image_versions_original_is_pristine check (kind <> 'original' or (prompt_text is null and model is null and cost_usd is null
    and parent_version_id is null and description_injected is null and description_missing is null)),
  constraint image_versions_generated_is_attributed check (kind <> 'generated' or (prompt_text is not null and model is not null and cost_usd is not null
    and description_injected is not null and description_missing is not null and not (description_injected and description_missing))));
create table public.product_draft_images (id serial primary key, image_version_id uuid not null references public.image_versions (id));
create table public.events (entity_type text, entity_id uuid, event text, detail jsonb, actor text);
`
const FILE = '11111111-1111-4111-8111-111111111111'
const CALL = `select public.replace_intake_image_from_agent('${FILE}', 'manual/x/v1.png', 'manual/x/t1.webp', 1254, 1254, 'abcd', 'agent', 'ready', 'stones were dull', null, 'sha')`

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-reenhance-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55445'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55445, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query(SCHEMA)
    await pool.query(`insert into public.intake_files (id, agent_tag, reenhance_note) values ('${FILE}', 'needs_review', 'stones were dull')`)
    const first = (await pool.query(`insert into public.image_versions (intake_file_id, version_no, kind, storage_key, is_selected) values ('${FILE}', 0, 'original', 'manual/x/original.png', true) returning id`)).rows[0].id
    await pool.query('insert into public.product_draft_images (image_version_id) values ($1)', [first])

    // Control: the function as first shipped is refused by the check, which is what production answered.
    const shipped = readFileSync('supabase/migrations/20261010120000_reenhance.sql', 'utf8').match(/create or replace function public\.replace_intake_image_from_agent\([\s\S]*?\n\$\$;\n/)
    assert.ok(shipped, 'the shipped function is in the D145 migration')
    await pool.query(shipped[0])
    await assert.rejects(pool.query(CALL), (e: { code?: string; constraint?: string }) => e.code === '23514' && e.constraint === 'image_versions_generated_is_attributed')
    checks.push('the function as shipped is refused with 23514 (the production error)')

    await pool.query(readFileSync('supabase/migrations/20261010140000_reenhance_replace_attribution.sql', 'utf8'))
    const out = (await pool.query(CALL)).rows[0].replace_intake_image_from_agent
    assert.deepEqual(out, { intake_id: FILE, version_no: 1 }); checks.push('the fixed function appends version 1')
    const versions = (await pool.query('select version_no, kind, is_selected, model, cost_usd::float as cost, description_injected, description_missing, id from public.image_versions order by version_no')).rows
    assert.deepEqual(versions.map(v => [v.version_no, v.kind, v.is_selected]), [[0, 'original', false], [1, 'generated', true]]); checks.push('the new version is selected, the old one is not')
    assert.deepEqual([versions[1].model, versions[1].cost, versions[1].description_injected, versions[1].description_missing], ['claude-agent', 0, false, false]); checks.push('it records no cost and no describer')
    assert.equal((await pool.query('select image_version_id from public.product_draft_images')).rows[0].image_version_id, versions[1].id); checks.push('a draft that showed the old image shows the new one')
    const file = (await pool.query('select agent_tag, agent_note, reenhance_note from public.intake_files')).rows[0]
    assert.deepEqual([file.agent_tag, file.agent_note, file.reenhance_note], ['ready', 'stones were dull', null]); checks.push('the row takes the new tag and note and stops saying re-enhancing')
    assert.equal((await pool.query("select count(*)::int as n from public.events where event = 'intake.agent_replaced'")).rows[0].n, 1); checks.push('one intake.agent_replaced event')
    assert.deepEqual((await pool.query(CALL.replace('v1.png', 'v2.png'))).rows[0].replace_intake_image_from_agent, { intake_id: FILE, version_no: 2 }); checks.push('a second replacement appends version 2')
    for (const c of checks) console.log('ok  ' + c)
    console.log(`${checks.length} checks passed`)
  } finally {
    await pool.end().catch(() => {}); child.kill('SIGINT')
  }
}
main().catch(error => { console.error(error); process.exit(1) })
