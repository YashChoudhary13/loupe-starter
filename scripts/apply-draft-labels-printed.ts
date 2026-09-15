/** Apply only labels_printed on product_drafts. Does not run unrelated migrations. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'dotenv'
import { pgClient } from './lib/pg'

async function main() {
  const [envFile, receiptFile] = process.argv.slice(2)
  if (!envFile || !receiptFile) throw new Error('Usage: <production-env-file> <receipt-file>')
  Object.assign(process.env, parse(readFileSync(envFile)))
  if (process.env.AUTH_BASE_URL !== 'https://loupe.qimati-eng.site') throw new Error('This rollout targets the configured production Loupe origin.')
  const file = '20260915180000_draft_labels_printed.sql'
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
    const column = (await db.query("select column_default, is_nullable from information_schema.columns where table_schema='public' and table_name='product_drafts' and column_name='labels_printed'")).rows[0]
    if (!column || column.is_nullable !== 'NO' || !String(column.column_default).includes('false')) throw new Error('labels_printed is missing or not default false.')
    const printed = (await db.query('select count(*)::int as n from product_drafts where labels_printed')).rows[0].n
    if (printed !== 0) throw new Error('Existing drafts were unexpectedly marked printed.')
    const perms = (await db.query(`select relrowsecurity, has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE') anon_access, has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE') authenticated_access from pg_class where oid='public.product_drafts'::regclass`)).rows[0]
    if (!perms.relrowsecurity || perms.anon_access || perms.authenticated_access) throw new Error('product_drafts permissions failed the release check.')
    await db.query('commit')
    const receipt = {
      projectRef: process.env.SUPABASE_PROJECT_REF,
      file,
      sha256: createHash('sha256').update(sql).digest('hex'),
      alreadyApplied: Boolean(existing.rowCount),
      labelsPrintedTrue: printed,
      committedAt: new Date().toISOString(),
    }
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally {
    await db.end()
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
