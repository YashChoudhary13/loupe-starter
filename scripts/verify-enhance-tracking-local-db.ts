/** Isolated proof of the D170 SQL: per-photo states, passes, the three-try rule, a limit hold, a crashed run, retry, the old
 *  runner's done/failed, and the runner's heartbeat with its commands. Temporary local PostgreSQL only; no .env, no network. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

const SCHEMA = `
create role anon; create role authenticated; create role service_role bypassrls;
create table public.agent_jobs (id uuid primary key default gen_random_uuid(), label text not null unique,
  status text not null default 'collecting' check (status in ('collecting', 'queued', 'running', 'done', 'failed')), created_by text not null,
  created_at timestamptz not null default now(), queued_at timestamptz, started_at timestamptz, finished_at timestamptz, lease_until timestamptz,
  runner text, note text, photo_count integer not null default 0, result_count integer not null default 0, error text,
  kind text not null default 'batch' check (kind in ('batch', 'redo', 'render')), instructions text, redo_of_intake_id uuid, restock jsonb);
create table public.agent_job_photos (id uuid primary key default gen_random_uuid(), job_id uuid not null references public.agent_jobs (id) on delete cascade,
  storage_key text not null, filename text not null, bytes integer, status text not null default 'pending' check (status in ('pending', 'uploaded')),
  created_at timestamptz not null default now(), restock jsonb, restock_state text);
create table public.intake_files (id uuid primary key default gen_random_uuid(), agent_source_photo_id uuid references public.agent_job_photos (id) on delete set null,
  reenhance_job_id uuid, reenhance_note text, agent_batch text);
create table public.events (id bigserial primary key, entity_type text, entity_id uuid, event text, detail jsonb, actor text);
create function public.agent_job_claim(p_runner text, p_lease_seconds integer) returns jsonb language sql as 'select null::jsonb';
create function public.agent_job_finish(p_job_id uuid, p_runner text, p_status text, p_note text, p_error text, p_result_count integer) returns void language sql as 'select';
`
const R = 'canada-1'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-tracking-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55447'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55447, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pool.query(sql, args)).rows[0] as T
  const job = async (label: string, n: number, extra = `'queued', now()`) => {
    const { id } = await one<{ id: string }>(`insert into public.agent_jobs (label, created_by, status, queued_at, photo_count) values ($1, 'owner@example.test', ${extra}, $2) returning id`, [label, n])
    for (let i = 1; i <= n; i++) await pool.query(`insert into public.agent_job_photos (job_id, storage_key, filename, status, created_at) values ($1, $2, $3, 'uploaded', now() + $4 * interval '1 ms')`, [id, `intake/${id}/${i}.jpg`, `${i}.jpg`, i])
    return id
  }
  const states = async (id: string) => (await pool.query(`select filename, work_state, attempts from public.agent_job_photos where job_id = $1 order by created_at`, [id])).rows.map((r) => `${r.filename}:${r.work_state}:${r.attempts}`).join(' ')
  const claim = (max: number | null = null) => one<{ r: { id: string; photo_count: number; pass: number } | null }>(`select public.agent_job_claim($1, 1800, $2) as r`, [R, max])
  const pass = (id: string, outcome: string, resume: string | null = null, err: string | null = null, count = 0) =>
    one<{ s: string }>(`select public.agent_job_pass($1, $2, $3, $4::timestamptz, 'note', $5, $6) as s`, [id, R, outcome, resume, err, count])
  const deliver = (id: string, filename: string) => pool.query(`insert into public.intake_files (agent_source_photo_id) select id from public.agent_job_photos where job_id = $1 and filename = $2`, [id, filename])
  const jobRow = (id: string) => one<{ status: string; hold_reason: string | null; held: boolean; result_count: number; passes: number }>(`select status, hold_reason, not_before > now() as held, result_count, passes from public.agent_jobs where id = $1`, [id])
  const soon = async (id: string) => pool.query(`update public.agent_jobs set not_before = null where id = $1`, [id])
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query(SCHEMA)

    // Before the migration: a finished job with one delivery, one restock and one photograph that never arrived.
    const old = await job('old 2026-11-01', 3, `'done', now()`)
    await pool.query(`insert into public.intake_files (agent_source_photo_id) select id from public.agent_job_photos where job_id = $1 and filename = '1.jpg'`, [old])
    await pool.query(`update public.agent_job_photos set restock_state = 'pending' where job_id = $1 and filename = '2.jpg'`, [old])
    await pool.query(readFileSync('supabase/migrations/20261114090000_enhance_photo_tracking.sql', 'utf8'))
    assert.equal(await states(old), '1.jpg:done:0 2.jpg:restock:0 3.jpg:failed:0'); checks.push('the backfill tells an old batch honestly: delivered, restock, never delivered')
    const dead = await job('old 2026-11-06 nothing delivered', 1, `'failed', now()`)
    await pool.query(`update public.agent_job_photos set work_state = 'failed', last_error = 'No delivery on record (from before per-photo tracking).' where job_id = $1`, [dead])
    await pool.query(readFileSync('supabase/migrations/20261114110000_enhance_backfill_repair.sql', 'utf8'))
    assert.deepEqual([await states(old), await states(dead)], ['1.jpg:done:0 2.jpg:restock:0 3.jpg:done:0', '1.jpg:failed:0']); checks.push('the repair: an old batch that delivered something reads done, one that delivered nothing stays failed')

    // A batch of five, three at a time. Two deliveries and a restock; the pass ends and the other two go on at once.
    const a = await job('2026-11-14 11.52', 5)
    const c1 = (await claim(3)).r
    assert.deepEqual([c1?.id, c1?.photo_count, c1?.pass], [a, 3, 1])
    assert.equal(await states(a), '1.jpg:working:0 2.jpg:working:0 3.jpg:working:0 4.jpg:waiting:0 5.jpg:waiting:0'); checks.push('a claim takes at most max_photos and leaves the rest waiting')
    assert.equal((await claim(3)).r, null); checks.push('a running job is not claimed twice')
    await deliver(a, '1.jpg'); await deliver(a, '2.jpg')
    await pool.query(`update public.agent_job_photos set restock_state = 'pending' where job_id = $1 and filename = '3.jpg'`, [a])
    assert.equal((await pass(a, 'ok', null, null, 2)).s, 'queued')
    assert.equal(await states(a), '1.jpg:done:0 2.jpg:done:0 3.jpg:restock:0 4.jpg:waiting:0 5.jpg:waiting:0')
    assert.deepEqual(await jobRow(a), { status: 'queued', hold_reason: null, held: null, result_count: 2, passes: 1 }); checks.push('a pass that delivered everything it took requeues the rest with no wait')

    // Second pass: the limit runs out after one delivery. The other photograph waits, with no try counted, until the reset.
    assert.equal((await claim(3)).r?.photo_count, 2)
    await deliver(a, '4.jpg')
    assert.equal((await pass(a, 'limit', new Date(Date.now() + 3_600_000).toISOString(), 'Codex: out of credits', 1)).s, 'queued')
    assert.equal(await states(a), '1.jpg:done:0 2.jpg:done:0 3.jpg:restock:0 4.jpg:done:0 5.jpg:waiting:0')
    assert.deepEqual(await jobRow(a), { status: 'queued', hold_reason: 'limit', held: true, result_count: 3, passes: 2 })
    assert.equal((await claim()).r, null); checks.push('a limit sends the undelivered photograph back with no try counted, and the job is not claimed before the reset')
    assert.equal((await one<{ n: number }>(`select public.agent_jobs_release_holds('owner@example.test') as n`)).n, 1)
    assert.equal((await claim()).r?.photo_count, 1); checks.push('"Try now" releases the hold')

    // That photograph fails three times: back to the queue twice with a minute's wait, then failed for a human.
    assert.equal((await pass(a, 'error', null, 'The image tool refused this photo.')).s, 'queued')
    assert.equal(await states(a).then((s) => s.split(' ')[4]), '5.jpg:waiting:1')
    assert.equal((await jobRow(a)).held, true); assert.equal((await claim()).r, null); checks.push('a failed try waits a minute before the next')
    await soon(a); await claim(); await pass(a, 'ok')  // ran to the end, delivered nothing: also a try
    assert.equal(await states(a).then((s) => s.split(' ')[4]), '5.jpg:waiting:2')
    await soon(a); await claim()
    assert.equal((await pass(a, 'error', null, 'The image tool refused this photo.')).s, 'done')
    assert.equal(await states(a).then((s) => s.split(' ')[4]), '5.jpg:failed:3')
    const done = await one<{ status: string; error: string; finished: boolean }>(`select status, error, finished_at is not null as finished from public.agent_jobs where id = $1`, [a])
    assert.deepEqual(done, { status: 'done', error: 'The image tool refused this photo.', finished: true }); checks.push('the third failed try is final: the photograph is failed with its reason and the batch finishes')

    // The owner sends it back; this time it lands.
    assert.equal((await one<{ n: number }>(`select public.agent_job_retry_photos($1, null, 'owner@example.test') as n`, [a])).n, 1)
    assert.equal((await jobRow(a)).status, 'queued'); assert.equal(await states(a).then((s) => s.split(' ')[4]), '5.jpg:waiting:0')
    await claim(); await deliver(a, '5.jpg')
    assert.equal((await pass(a, 'ok', null, null, 1)).s, 'done')
    assert.deepEqual([(await jobRow(a)).result_count, await states(a).then((s) => s.split(' ')[4])], [4, '5.jpg:done:0']); checks.push('Retry reopens a finished batch for the failed photograph only, and it finishes again')

    // A sign-in is lost: nothing is tried, the job waits with no clock, and is claimable the moment the runner asks again.
    const b = await job('2026-11-14 12.09', 2)
    await claim()
    assert.equal((await pass(b, 'login', null, 'OAuth session expired')).s, 'queued')
    assert.deepEqual([await states(b), (await jobRow(b)).hold_reason, (await jobRow(b)).held], ['1.jpg:waiting:0 2.jpg:waiting:0', 'login', null]); checks.push('a lost sign-in counts no try and sets no clock')

    // The runner dies mid-run: when the lease lapses the next claim counts a try and takes the photographs again. Three crashes end it.
    await claim()
    for (let n = 1; n <= 2; n++) {
      await pool.query(`update public.agent_jobs set lease_until = now() - interval '1 second' where id = $1`, [b])
      assert.equal((await claim()).r, null)  // the lapsed run is closed; the retry waits its minute
      assert.equal(await states(b), `1.jpg:waiting:${n} 2.jpg:waiting:${n}`)
      await soon(b); assert.equal((await claim()).r?.photo_count, 2)
    }
    await pool.query(`update public.agent_jobs set lease_until = now() - interval '1 second' where id = $1`, [b])
    assert.equal((await claim()).r, null)
    assert.deepEqual([await states(b), (await jobRow(b)).status], ['1.jpg:failed:3 2.jpg:failed:3', 'failed']); checks.push('a run that crashes three times stops instead of repeating for ever')

    // The runner of before: claim with two arguments, then done or failed.
    const c = await job('2026-11-14 12.27', 2)
    assert.equal((await one<{ r: { photo_count: number } }>(`select public.agent_job_claim($1, 1800) as r`, [R])).r.photo_count, 2)
    await deliver(c, '1.jpg')
    await pool.query(`select public.agent_job_finish($1, $2, 'done', 'old runner', null, 1)`, [c, R])
    assert.deepEqual([await states(c), (await jobRow(c)).status], ['1.jpg:done:0 2.jpg:waiting:1', 'queued']); checks.push('the old runner still works, and what it did not deliver now goes back to the queue')
    await assert.rejects(pass(c, 'ok'), (e: { code?: string }) => e.code === '55000'); checks.push('a pass for a job that is not running is refused')

    // A redo delivers by replacing the image: the replacement clears reenhance_job_id.
    const { id: intake } = await one<{ id: string }>(`insert into public.intake_files default values returning id`)
    const d = await job('redo 2026-11-14 tulip', 1)
    await pool.query(`update public.agent_jobs set kind = 'redo', redo_of_intake_id = $2, queued_at = now() - interval '1 hour' where id = $1`, [d, intake])
    await pool.query(`update public.intake_files set reenhance_job_id = $2 where id = $1`, [intake, d])
    await pool.query(`update public.agent_jobs set status = 'done' where id = $1`, [c])
    assert.equal((await claim()).r?.id, d)
    await pool.query(`update public.intake_files set reenhance_job_id = null where id = $1`, [intake])
    assert.equal((await pass(d, 'ok', null, null, 1)).s, 'done'); assert.equal(await states(d), '1.jpg:done:0'); checks.push('a redo is done when its replacement landed')

    // The heartbeat: the report is stored, a command goes out once, its answer closes it and wipes the sign-in code.
    const report = (results: unknown[] = []) => one<{ r: { id: string; kind: string; payload: { code?: string } }[] }>(`select public.agent_runner_report($1, '{"state":"idle"}'::jsonb, 'log line', $2::jsonb) as r`, [R, JSON.stringify(results)])
    assert.deepEqual((await report()).r, [])
    await pool.query(`insert into public.agent_runner_commands (runner, kind, payload, created_by) values ($1, 'claude_login_code', '{"code":"abcdefgh#12345678"}', 'owner@example.test')`, [R])
    const sent = (await report()).r
    assert.deepEqual([sent.length, sent[0].kind, sent[0].payload.code], [1, 'claude_login_code', 'abcdefgh#12345678'])
    assert.deepEqual((await report()).r, []); checks.push('a command is handed to the runner exactly once')
    await report([{ id: sent[0].id, ok: true, result: 'Signed in.' }])
    const cmd = await one<{ state: string; result: string; payload: object }>(`select state, result, payload from public.agent_runner_commands where id = $1`, [sent[0].id])
    assert.deepEqual(cmd, { state: 'done', result: 'Signed in.', payload: {} }); checks.push('the answer closes the command and the sign-in code is wiped')
    await assert.rejects(pool.query(`insert into public.agent_runner_commands (runner, kind, created_by) values ($1, 'shell', 'x')`, [R])); checks.push('a command kind outside the fixed list cannot even be stored')
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from public.agent_runner_status`)).n, 1)

    console.log(JSON.stringify({ ok: true, checks: checks.length, proved: checks }, null, 1))
  } finally {
    await pool.end().catch(() => undefined)
    child.kill('SIGTERM')
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
