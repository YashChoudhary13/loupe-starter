/** Isolated proof of the home_probe_state schema. Temporary local PostgreSQL only; no .env, no network. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-home-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55441'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55441, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  const refuses = async (name: string, sql: string) => { await assert.rejects(pool.query(sql), name); checks.push(name) }
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query('create role anon; create role authenticated; create role service_role bypassrls;')
    await pool.query('alter default privileges in schema public grant all on tables to anon, authenticated, service_role;')
    await pool.query(readFileSync('supabase/migrations/20260923100000_home_probe_state.sql', 'utf8'))
    await pool.query("insert into public.home_probe_state(probe_key,status,detail) values('shopify','green','300 ms')")
    await refuses('a probe has one row', "insert into public.home_probe_state(probe_key,status) values('shopify','red')")
    await refuses('status is green, amber or red', "insert into public.home_probe_state(probe_key,status) values('loupe','blue')")
    await refuses('a key is a short slug', "insert into public.home_probe_state(probe_key,status) values('not a key!','red')")
    await pool.query("insert into public.home_probe_state(probe_key,status,detail,since,checked_at) values('shopify','red','HTTP 502',now(),now()) on conflict (probe_key) do update set status=excluded.status, detail=excluded.detail, since=excluded.since, checked_at=excluded.checked_at")
    assert.equal((await pool.query("select status from public.home_probe_state where probe_key='shopify'")).rows[0].status, 'red'); checks.push('upsert by key replaces the state')
    assert.equal((await pool.query("select relrowsecurity from pg_class where oid='public.home_probe_state'::regclass")).rows[0].relrowsecurity, true); checks.push('row level security is on')
    assert.equal((await pool.query("select count(*)::int as n from pg_policy where polrelid='public.home_probe_state'::regclass")).rows[0].n, 0); checks.push('zero policies')
    for (const role of ['anon', 'authenticated']) {
      const conn = await pool.connect()
      try { await conn.query(`set role ${role}`); await assert.rejects(conn.query('select 1 from public.home_probe_state')); checks.push(`${role} cannot read`) } finally { await conn.query('reset role'); conn.release() }
    }
    const admin = await pool.connect()
    try {
      await admin.query('set role service_role')
      await admin.query("insert into public.home_probe_state(probe_key,status,detail) values('linkedin','green','ok')")
      assert.equal((await admin.query("select status from public.home_probe_state where probe_key='linkedin'")).rows[0].status, 'green')
      checks.push('service_role can read and write')
    } finally { await admin.query('reset role'); admin.release() }
    console.log(`home schema proof: ${checks.length} checks passed\n- ${checks.join('\n- ')}`)
  } finally { await pool.end(); child.kill('SIGINT') }
}
main().catch(error => { console.error(error); process.exit(1) })
