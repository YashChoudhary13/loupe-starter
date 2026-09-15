/** Explicit two-phase rollout. Never applies unrelated pending migrations. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'dotenv'
import { pgClient } from './lib/pg'

async function main() {
  const [mode, envFile, receiptFile] = process.argv.slice(2)
  if (!['--prepare', '--activate'].includes(mode) || !envFile || !receiptFile) throw new Error('Usage: --prepare|--activate <env-file> <receipt-file>')
  Object.assign(process.env, parse(readFileSync(envFile)))
  if (process.env.AUTH_BASE_URL !== 'https://loupe.qimati-eng.site') throw new Error('This rollout targets the configured production Loupe origin.')
  const files = mode === '--prepare' ? ['20260915080000_variant_barcode_scheme.sql', '20260915081237_order_qc_sessions.sql', '20260915081241_colour_size_combinations.sql'] : ['20260915083506_activate_variant_codes.sql']
  const db = pgClient(); await db.connect()
  const applied: { file: string; sha256: string }[] = []
  try {
    await db.query('begin')
    await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'")
    await db.query("select pg_advisory_xact_lock(hashtext('loupe-qc-rollout'))")
    for (const file of files) {
      const version = file.split('_')[0]
      const existing = await db.query('select version from supabase_migrations.schema_migrations where version=$1',[version])
      if (existing.rowCount) { console.log(`Already applied: ${file}`); continue }
      const sql = readFileSync(`supabase/migrations/${file}`,'utf8')
      await db.query(sql)
      await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',[version,file.slice(version.length+1,-4),[sql]])
      applied.push({ file, sha256:createHash('sha256').update(sql).digest('hex') })
    }
    const schemes = (await db.query('select sku_scheme,count(*)::integer count from product_drafts group by sku_scheme order by sku_scheme')).rows
    const permissions = (await db.query(`select c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon_access,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated_access
      from pg_class c where c.oid in ('public.qc_sessions'::regclass,'public.qc_events'::regclass)`)).rows
    if(permissions.some(p=>!p.relrowsecurity||p.anon_access||p.authenticated_access)) throw new Error('QC table permissions failed the release check.')
    const rpc = (await db.query("select has_function_privilege('anon',oid,'EXECUTE') anon_access,has_function_privilege('authenticated',oid,'EXECUTE') authenticated_access,has_function_privilege('service_role',oid,'EXECUTE') server_access from pg_proc where pronamespace='public'::regnamespace and proname='qc_command'")).rows
    if(rpc.length!==1 || rpc.some(p=>p.anon_access||p.authenticated_access||!p.server_access)) throw new Error('QC RPC permissions failed the release check.')
    const currentDefault = (await db.query("select column_default from information_schema.columns where table_schema='public' and table_name='product_drafts' and column_name='sku_scheme'")).rows[0].column_default
    await db.query('commit')
    const receipt = {mode,projectRef:process.env.SUPABASE_PROJECT_REF,applied,schemes,currentDefault,permissions,rpc,committedAt:new Date().toISOString()}
    writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n')
    console.log(JSON.stringify(receipt,null,2))
  } catch(error) { await db.query('rollback'); throw error }
  finally { await db.end() }
}
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1})
