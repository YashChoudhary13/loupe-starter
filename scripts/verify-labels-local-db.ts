/** Isolated PostgreSQL proof. Never reads .env or contacts the deployed database. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { formatSku } from '../src/lib/publish/identity'
import { variantSkus } from '../src/lib/publish/variant-sku'

async function main() {
  const binaries = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-label-db-'))
  const data = join(root, 'data')
  execFileSync(join(binaries, 'initdb'), ['-D', data, '-U', 'loupe_label_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  // Empty listen_addresses means no TCP listener; the private temporary socket
  // directory and database disappear from use when this child stops.
  const child = spawn(join(binaries, 'postgres'), ['-D', data, '-h', '', '-k', root, '-p', '55437', '-N', '40'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55437, user: 'loupe_label_test', database: 'postgres', max: 20 })
  try {
    for (let attempt = 0; ; attempt++) {
      try { await pool.query('select 1'); break }
      catch (error) { if (attempt >= 49) throw error; await new Promise(r => setTimeout(r, 100)) }
    }
    await pool.query(`create role anon; create role authenticated; create role service_role;
      create table public.sku_counters(sku_prefix text primary key, last_number integer not null, updated_at timestamptz default now());
      insert into public.sku_counters(sku_prefix,last_number) values ('NK',1332);
      create table public.product_drafts(id text primary key, title text);
      insert into public.product_drafts values ('old','Existing draft');`)
    const allocator = readFileSync('supabase/migrations/20260728120900_next_sku.sql', 'utf8')
    const migration = readFileSync('supabase/migrations/20260915080000_variant_barcode_scheme.sql', 'utf8')
    await pool.query(allocator)
    await pool.query(migration)
    await pool.query("insert into product_drafts(id,title) values ('new','New draft')")
    const schemes = (await pool.query('select id,sku_scheme from product_drafts order by id')).rows
    assert.deepEqual(schemes, [{ id: 'new', sku_scheme: 'variant-v1' }, { id: 'old', sku_scheme: 'legacy' }])
    await assert.rejects(pool.query("update product_drafts set sku_scheme='variant-v1' where id='old'"), /cannot be changed/)
    await pool.query("update product_drafts set title='Edited title' where id='new'")
    const started = Date.now()
    const numbers = await Promise.all(Array.from({ length: 100 }, async () => {
      const connection = await pool.connect()
      try {
        await connection.query('begin')
        const result = await connection.query("select public.next_sku('NK') as number")
        await connection.query('select pg_sleep(0.01)') // Keep the row lock held while other callers arrive.
        await connection.query('commit')
        return result.rows[0].number as number
      } catch (error) { await connection.query('rollback'); throw error }
      finally { connection.release() }
    }))
    assert.deepEqual([...numbers].sort((a,b) => a-b), Array.from({ length: 100 }, (_, i) => 1333+i))
    const codes = numbers.flatMap(n => variantSkus(formatSku('NK', n), 'colour', ['White','Green','Pink'], 'variant-v1'))
    assert.equal(new Set(codes).size, 300)
    await assert.rejects(pool.query("select next_sku('BAD')"), /unknown SKU prefix/)
    const receipt = { database: 'temporary local PostgreSQL only', allocatorSha256: createHash('sha256').update(allocator).digest('hex'), migrationSha256: createHash('sha256').update(migration).digest('hex'), schemes, schemeChangeRejected: true, normalEditAccepted: true, concurrentRequests: 100, connections: 20, distinctParentNumbers: new Set(numbers).size, distinctVariantCodes: new Set(codes).size, range: [1333,1432], elapsedMs: Date.now()-started, limitation: 'Tests allocator and isolated migration, not full deployed schema or parallel Shopify publishes.', temporaryDataDirectory: data }
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(receipt, null, 2)+'\n')
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await pool.end()
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (child.exitCode === null) { child.kill('SIGTERM'); await stopped }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
