/** Isolated proof of the D148 SQL: register a photograph given to Claude directly, post a restock candidate, and the three choices.
 *  Temporary local PostgreSQL only; no .env, no network. The tables hold the columns the functions touch, with the D143/D145 shapes. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

const SCHEMA = `
create role anon; create role authenticated; create role service_role bypassrls;
create table public.product_drafts (id uuid primary key);
create table public.intake_files (id uuid primary key default gen_random_uuid(), product_draft_id uuid, restock_sku text, agent_suggest jsonb, discovered_at timestamptz not null default now());
create table public.agent_jobs (id uuid primary key default gen_random_uuid(), label text not null unique check (length(btrim(label)) between 3 and 80),
  status text not null default 'collecting' check (status in ('collecting', 'queued', 'running', 'done', 'failed')), created_by text not null,
  created_at timestamptz not null default now(), queued_at timestamptz, finished_at timestamptz, note text, photo_count integer not null default 0);
alter table public.agent_jobs add column kind text not null default 'batch' check (kind in ('batch', 'redo')), add column instructions text;
create table public.agent_job_photos (id uuid primary key default gen_random_uuid(), job_id uuid not null references public.agent_jobs (id) on delete cascade,
  storage_key text not null, filename text not null, bytes integer, status text not null default 'pending' check (status in ('pending', 'uploaded')),
  created_at timestamptz not null default now());
create table public.events (id bigserial primary key, entity_type text, entity_id uuid, event text, detail jsonb, actor text);
`
const AGENT = 'agent@claude.local'
const OWNER = 'owner@example.test'
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const P3 = '33333333-3333-4333-8333-333333333333'
const RESTOCK = JSON.stringify({ kind: 'old', note: 'same clasp', candidates: [{ sku: 'CB554', handle: 'chain-bracelet-554' }] })

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-restock-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55446'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55446, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pool.query(sql, args)).rows[0] as T
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query(SCHEMA)
    await pool.query(readFileSync('supabase/migrations/20261012090000_restock_candidates.sql', 'utf8'))

    // A zip given to Claude in a chat: the first photograph creates a finished batch, the next ones join it.
    const reg = (id: string, name: string, label = 'WhatsApp 2026-10-12 at 18.58') =>
      one<{ r: { photo_id: string; duplicate: boolean } }>(`select public.agent_register_photo($1, $2, $3, $4, 1000, $5) as r`, [label, id, `intake/direct/${id}.jpg`, name, AGENT])
    assert.deepEqual((await reg(P1, 'a.jpg')).r, { photo_id: P1, duplicate: false })
    assert.deepEqual((await reg(P2, 'b.jpg')).r, { photo_id: P2, duplicate: false })
    const job = await one<{ status: string; kind: string; photo_count: number; queued_at: string | null }>(`select status, kind, photo_count, queued_at from public.agent_jobs`)
    assert.deepEqual(job, { status: 'done', kind: 'batch', photo_count: 2, queued_at: null }); checks.push('two photographs registered into one finished batch that nothing will claim')
    assert.deepEqual((await reg(P3, 'a.jpg')).r, { photo_id: P1, duplicate: true }); checks.push('the same filename again returns the first photograph')
    await pool.query(`insert into public.agent_jobs (label, created_by) values ('2026-10-12 14.30', $1)`, [OWNER])
    await assert.rejects(reg(P3, 'c.jpg', '2026-10-12 14.30'), (e: { code?: string }) => e.code === '55000'); checks.push('a batch an operator sent from Loupe takes no photograph from outside')

    // Claude posts the candidate; posting again only refreshes it.
    const post = (id: string, body = RESTOCK) => one<{ s: string }>(`select public.post_restock_candidate($1, $2::jsonb, $3) as s`, [id, body, AGENT])
    assert.equal((await post(P1)).s, 'pending')
    assert.equal((await post(P1, RESTOCK.replace('same clasp', 'same clasp, 36 in stock'))).s, 'pending')
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from public.events where event = 'restock.candidate_posted'`)).n, 1)
    assert.equal((await one<{ note: string }>(`select restock->>'note' as note from public.agent_job_photos where id = $1`, [P1])).note, 'same clasp, 36 in stock')
    checks.push('a candidate is pending after the post, a repeat refreshes it and raises the badge once')
    await assert.rejects(post(P2, '{"kind":"maybe"}'), (e: { code?: string }) => e.code === '22023'); checks.push('a kind other than old or unsure is refused')

    // Use old image: the app has put the listing image into Pending; the candidate closes and no job is made.
    const decide = (id: string, state: string, sku: string | null, restock: string | null, label: string | null) =>
      one<{ r: { state: string; job_id?: string; label?: string } }>(`select public.decide_restock_candidate($1, $2, $3, $4::jsonb, 'note for the runner', $5, $6) as r`, [id, state, sku, restock, label, OWNER])
    assert.deepEqual((await decide(P1, 'use_old', 'CB554', null, null)).r, { state: 'use_old' })
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from public.agent_jobs where kind = 'render'`)).n, 0)
    const closed = await one<{ restock_state: string; restock_decided_by: string }>(`select restock_state, restock_decided_by from public.agent_job_photos where id = $1`, [P1])
    assert.deepEqual(closed, { restock_state: 'use_old', restock_decided_by: OWNER }); checks.push('use old image closes the candidate under the operator and queues nothing')
    await assert.rejects(decide(P1, 'wrong', null, null, 'new 2026-10-12 a'), (e: { code?: string }) => e.code === '55000'); checks.push('a second choice on the same photograph is refused')
    assert.equal((await post(P1)).s, 'use_old'); checks.push('a later post from Claude does not reopen it')

    // Generate new image: one queued render job carrying the same stored photograph and the old product.
    assert.equal((await post(P2)).s, 'pending')
    const made = (await decide(P2, 'generate', 'CB554', '{"sku":"CB554","handle":"chain-bracelet-554","also":[],"also_archive":[]}', 'restock 2026-10-12 b')).r
    const render = await one<{ kind: string; status: string; restock: { sku: string }; instructions: string; photo_count: number; storage_key: string; filename: string }>(
      `select j.kind, j.status, j.restock, j.instructions, j.photo_count, p.storage_key, p.filename from public.agent_jobs j join public.agent_job_photos p on p.job_id = j.id where j.id = $1`, [made.job_id])
    assert.deepEqual([render.kind, render.status, render.restock.sku, render.instructions, render.photo_count, render.storage_key, render.filename],
      ['render', 'queued', 'CB554', 'note for the runner', 1, `intake/direct/${P2}.jpg`, 'b.jpg'])
    assert.equal(made.label, 'restock 2026-10-12 b'); checks.push('generate queues one render job with the photograph and the old product')

    // Wrong restock: a render job with no old product; a taken label gets a counter.
    await reg(P3, 'c.jpg'); assert.equal((await post(P3, '{"kind":"unsure","candidates":[]}')).s, 'pending')
    const wrong = (await decide(P3, 'wrong', null, '{"sku":"CB554"}', 'restock 2026-10-12 b')).r
    const fresh = await one<{ restock: unknown; label: string }>(`select restock, label from public.agent_jobs where id = $1`, [wrong.job_id])
    assert.deepEqual(fresh, { restock: null, label: 'restock 2026-10-12 b 2' }); checks.push('wrong restock queues a render job with no old product, under a free label')
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from public.events where event = 'restock.candidate_decided'`)).n, 3); checks.push('each choice writes one restock.candidate_decided event')
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from public.agent_job_photos where restock_state = 'pending'`)).n, 0)

    // The other sold-out SKUs of the same design, read at publish.
    const draft = '44444444-4444-4444-8444-444444444444'
    await pool.query(`insert into public.intake_files (product_draft_id, restock_sku, agent_suggest) values ($1, 'CB554', '{"alsoArchive":["CB483","CB12"]}'), ($1, null, null)`, [draft])
    assert.deepEqual((await one<{ s: string[] }>(`select public.supersession_also_skus($1, 'CB554') as s`, [draft])).s, ['CB483', 'CB12'])
    assert.deepEqual((await one<{ s: string[] }>(`select public.supersession_also_skus($1, 'NK1') as s`, [draft])).s, []); checks.push('publish reads the other SKUs of the same design, and none for any other SKU')

    for (const c of checks) console.log('ok  ' + c)
    console.log(`${checks.length} checks passed`)
  } finally {
    await pool.end().catch(() => {}); child.kill('SIGINT')
  }
}
main().catch(error => { console.error(error); process.exit(1) })
