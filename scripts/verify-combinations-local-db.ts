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
    const baseline = readFileSync('tests/fixtures/variant-schema-before-combinations.sql', 'utf8')
    await pool.query(baseline)
    const category = (await pool.query("insert into categories(name,sku_prefix,title_pattern,shopify_tag) values ('Rings','RS','Rings {n}','Rings') returning id")).rows[0].id
    const old = (await pool.query('insert into product_drafts(category_id) values ($1) returning id', [category])).rows[0].id
    const allocator = readFileSync('supabase/migrations/20260728120900_next_sku.sql', 'utf8')
    const migration = readFileSync('supabase/migrations/20260915080000_variant_barcode_scheme.sql', 'utf8')
    await pool.query(migration)
    await pool.query(readFileSync('supabase/migrations/20260915081241_colour_size_combinations.sql','utf8'))
    const id = (await pool.query('insert into product_drafts(category_id) values ($1) returning id', [category])).rows[0].id
    const save = async (draft: string, kind: string, rows: object[]) => pool.query(`select save_product_draft(p_draft_id=>$1,p_expected_updated_at=>null,p_category_id=>$2,p_material_id=>null,p_title_suffix=>null,p_price_paise=>12000,p_weight_g=>20,p_stock=>0,p_variant_kind=>$3,p_variants=>$4::jsonb,p_actor=>'local-verification')`, [draft,category,kind,JSON.stringify(rows)])
    const pairs = [{value:'Gold',sizeValue:'7',stock:12},{value:'Gold',sizeValue:'8',stock:15},{value:'Silver',sizeValue:'8',stock:20}]
    await save(id, 'colour_size', pairs)
    const read = async () => (await pool.query('select option_value, size_value, stock from product_draft_variants where product_draft_id=$1 order by position',[id])).rows
    assert.deepEqual(await read(),pairs.map(v=>({option_value:v.value,size_value:v.sizeValue,stock:v.stock})))
    assert.equal((await pool.query('select stock from product_drafts where id=$1',[id])).rows[0].stock,47)
    await save(id, 'colour_size', [...pairs].reverse())
    assert.deepEqual(await read(),[...pairs].reverse().map(v=>({option_value:v.value,size_value:v.sizeValue,stock:v.stock})))
    await assert.rejects(save(id,'colour_size',[...pairs,{value:' gold ',sizeValue:'7',stock:5}]),/duplicate/)
    await assert.rejects(save(id,'colour_size',[{value:'Gold',stock:5}]),/selected size/)
    await assert.rejects(save(old,'colour_size',pairs),/new draft/)
    assert.equal((await read()).length,3)
    for (const kind of ['colour','size','number']) await save(id,kind,[{value:kind==='colour'?'Gold':'7',stock:12}])
    await save(id,'none',[])
    await pool.query("insert into sku_counters(sku_prefix,last_number) values ('NK',1332)")
    const schemes = (await pool.query('select sku_scheme from product_drafts order by sku_scheme')).rows
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
    const receipt = { database: 'temporary local PostgreSQL only', allocatorSha256: createHash('sha256').update(allocator).digest('hex'), migrationSha256: createHash('sha256').update(migration).digest('hex'), schemes, schemeChangeRejected: true, normalEditAccepted: true, concurrentRequests: 100, connections: 20, distinctParentNumbers: new Set(numbers).size, distinctVariantCodes: new Set(codes).size, range: [1333,1432], elapsedMs: Date.now()-started, sparseCombinations: true, reorder: true, rejectedInvalidAndLegacy: true, singleModes: true, limitation: 'Schema-only fixture and local transactions, no real store writes.', temporaryDataDirectory: data }
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(receipt, null, 2)+'\n')
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await pool.end()
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (child.exitCode === null) { child.kill('SIGTERM'); await stopped }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
