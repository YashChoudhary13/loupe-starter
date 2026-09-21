/** Isolated proof of the dispatch schema. Temporary local PostgreSQL only; no .env, no network. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-dispatch-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55440'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55440, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  const refuses = async (name: string, sql: string, params: unknown[] = []) => { await assert.rejects(pool.query(sql, params), undefined, name); checks.push(name) }
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query('create role anon; create role authenticated; create role service_role bypassrls;')
    await pool.query(readFileSync('supabase/migrations/20260921100000_dispatch.sql', 'utf8'))
    const shop = 'dispatch-test.myshopify.com', order = 'gid://shopify/Order/1'
    const parcel = async (tracking: string | null = 'X1234567') => (await pool.query("insert into public.dispatch_parcels(shop_domain,tracking_number,carrier,staged_by) values($1,$2,'DTDC','op@example.test') returning id", [shop, tracking])).rows[0].id as string
    const a = await parcel(), b = await parcel('X7654321')
    await pool.query('insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name) values($1,$2,$3,$4)', [a, shop, order, 'Qimati1'])
    await refuses('an order cannot sit in two open parcels', 'insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name) values($1,$2,$3,$4)', [b, shop, order, 'Qimati1'])
    await refuses('fulfilled needs a fulfilment id', "update public.dispatch_parcel_orders set status='fulfilled' where parcel_id=$1", [a])
    await pool.query("update public.dispatch_parcel_orders set status='fulfilled', fulfillment_id='gid://shopify/Fulfillment/9', finished_at=now() where parcel_id=$1", [a])
    await pool.query('insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name) values($1,$2,$3,$4)', [b, shop, order, 'Qimati1'])
    checks.push('a fulfilled row no longer blocks a new parcel for the same order')
    await refuses('tracking numbers are stored normalised', "insert into public.dispatch_parcels(shop_domain,tracking_number,staged_by) values($1,'x12 34','op')", [shop])
    await refuses('carrier is one of the three', "insert into public.dispatch_parcels(shop_domain,carrier,staged_by) values($1,'BlueDart','op')", [shop])
    await refuses('two orders cannot share a position', 'insert into public.dispatch_parcel_orders(parcel_id,shop_domain,order_id,order_name,position) values($1,$2,$3,$4,0)', [b, shop, 'gid://shopify/Order/2', 'Qimati2'])
    await pool.query('delete from public.dispatch_parcels where id=$1', [b])
    assert.equal((await pool.query('select count(*)::int as n from public.dispatch_parcel_orders where parcel_id=$1', [b])).rows[0].n, 0); checks.push('deleting a parcel removes its orders')
    const anon = await pool.connect()
    try { await anon.query('set role anon'); await assert.rejects(anon.query('select 1 from public.dispatch_parcels')); checks.push('anon cannot read') } finally { await anon.query('reset role'); anon.release() }
    console.log(`dispatch schema proof: ${checks.length} checks passed\n- ${checks.join('\n- ')}`)
  } finally { await pool.end(); child.kill('SIGINT') }
}
main().catch(error => { console.error(error); process.exit(1) })
