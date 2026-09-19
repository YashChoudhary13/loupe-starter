/**
 * Apply exactly one named migration to production and record it. Does not run unrelated pending migrations.
 *
 *   npx tsx scripts/apply-migration.ts <migration-file> <production-env-file> <receipt-file>
 *
 * Refuses unless the env file names the production origin. Verifies afterwards that qc_command still has one
 * 16-argument overload reachable by service_role only (the QC release invariant since D128).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'dotenv'
import { pgClient } from './lib/pg'

async function main() {
  const [file, envFile, receiptFile] = process.argv.slice(2)
  if (!file || !envFile || !receiptFile || !/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) throw new Error('Usage: <YYYYMMDDHHMMSS_name.sql> <production-env-file> <receipt-file>')
  Object.assign(process.env, parse(readFileSync(envFile)))
  if (process.env.AUTH_BASE_URL !== 'https://loupe.qimati-eng.site') throw new Error('This rollout targets the configured production Loupe origin.')
  const version = file.split('_')[0]
  const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
  const db = pgClient(); await db.connect()
  try {
    await db.query('begin')
    await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'")
    await db.query("select pg_advisory_xact_lock(hashtext('loupe-qc-rollout'))")
    const existing = await db.query('select version from supabase_migrations.schema_migrations where version=$1', [version])
    if (!existing.rowCount) {
      await db.query(sql)
      await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)', [version, file.slice(version.length + 1, -4), [sql]])
    }
    const rpc = (await db.query("select pronargs, has_function_privilege('anon',oid,'EXECUTE') anon_access, has_function_privilege('authenticated',oid,'EXECUTE') authenticated_access, has_function_privilege('service_role',oid,'EXECUTE') server_access from pg_proc where pronamespace='public'::regnamespace and proname='qc_command'")).rows
    if (rpc.length !== 1 || rpc[0].pronargs !== 16 || rpc.some(p => p.anon_access || p.authenticated_access || !p.server_access)) throw new Error('qc_command overload or permissions failed the release check.')
    const helpers = (await db.query("select proname, has_function_privilege('anon',oid,'EXECUTE') anon_access, has_function_privilege('service_role',oid,'EXECUTE') server_access from pg_proc where pronamespace='public'::regnamespace and proname like 'qc_%' order by proname")).rows
    if (helpers.some(p => p.anon_access || !p.server_access)) throw new Error('A qc_* helper is reachable by anon or not by service_role.')
    await db.query('commit')
    const receipt = { projectRef: process.env.SUPABASE_PROJECT_REF, file, sha256: createHash('sha256').update(sql).digest('hex'), alreadyApplied: Boolean(existing.rowCount), rpc: rpc[0], helpers, committedAt: new Date().toISOString() }
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) { await db.query('rollback'); throw error }
  finally { await db.end() }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
