/** Apply only the QC shortages migration (D128) to production. Does not run unrelated migrations. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'dotenv'
import { pgClient } from './lib/pg'

async function main() {
  const [envFile, receiptFile] = process.argv.slice(2)
  if (!envFile || !receiptFile) throw new Error('Usage: <production-env-file> <receipt-file>')
  Object.assign(process.env, parse(readFileSync(envFile)))
  if (process.env.AUTH_BASE_URL !== 'https://loupe.qimati-eng.site') throw new Error('This rollout targets the configured production Loupe origin.')
  const file = '20260918090000_qc_shortages.sql'
  const version = file.split('_')[0]
  const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
  const db = pgClient(); await db.connect()
  try {
    await db.query('begin')
    await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'")
    await db.query("select pg_advisory_xact_lock(hashtext('loupe-qc-rollout'))")
    const existing = await db.query('select version from supabase_migrations.schema_migrations where version=$1', [version])
    if (!existing.rowCount) {
      await db.query(sql)
      await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)', [version, file.slice(version.length + 1, -4), [sql]])
    }
    const rpc = (await db.query("select pronargs, pg_get_functiondef(oid) definition, has_function_privilege('anon',oid,'EXECUTE') anon_access, has_function_privilege('authenticated',oid,'EXECUTE') authenticated_access, has_function_privilege('service_role',oid,'EXECUTE') server_access from pg_proc where pronamespace='public'::regnamespace and proname='qc_command'")).rows
    if (rpc.length !== 1 || rpc[0].pronargs !== 16 || rpc.some(p => p.anon_access || p.authenticated_access || !p.server_access)) throw new Error('QC RPC overload or permissions failed the release check.')
    if (!rpc[0].definition.includes("p_action='short'") || !rpc[0].definition.includes('qc_shortages')) throw new Error('Deployed qc_command does not include shortages.')
    const table = (await db.query(`select c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid=c.oid) policies,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access, has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated_access,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE') server_access from pg_class c where c.oid='public.qc_shortages'::regclass`)).rows[0]
    if (!table || !table.relrowsecurity || table.policies !== 0 || table.anon_access || table.authenticated_access || !table.server_access) throw new Error('qc_shortages permissions failed the release check.')
    const sessions = (await db.query('select status, count(*)::int count from public.qc_sessions group by status order by status')).rows
    await db.query('commit')
    const receipt = { projectRef: process.env.SUPABASE_PROJECT_REF, file, sha256: createHash('sha256').update(sql).digest('hex'), alreadyApplied: Boolean(existing.rowCount),
      rpc: { pronargs: rpc[0].pronargs, anon_access: rpc[0].anon_access, authenticated_access: rpc[0].authenticated_access, server_access: rpc[0].server_access },
      table, existingSessions: sessions, committedAt: new Date().toISOString() }
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally { await db.end() }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
