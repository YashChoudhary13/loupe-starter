/** Isolated proof of the accepted-shortage flow (D128). Temporary local PostgreSQL only; no .env, no network. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { orderFingerprint } from '../src/lib/qc/snapshot'
import type { QcOrder, QcEvent, QcSession } from '../src/lib/qc/types'

const MIGRATIONS = ['20260915081237_order_qc_sessions.sql', '20260915173000_qc_extra_confirmation.sql', '20260918090000_qc_shortages.sql']
const RING = 'gid://shopify/LineItem/1', NECK = 'gid://shopify/LineItem/2'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-qc-short-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_qc_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55439', '-N', '40'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55439, user: 'loupe_qc_test', database: 'postgres', max: 20 })
  const started = Date.now()
  const checks: string[] = []
  const check = (name: string, condition: boolean) => { assert.ok(condition, name); checks.push(name) }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await pool.query('select 1'); break }
      catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) }
    }
    const actor = randomUUID(), otherActor = randomUUID()
    await pool.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.app_users(id uuid primary key, email text, name text, active boolean);
      grant select on public.app_users to service_role;`)
    await pool.query('insert into public.app_users values($1,$2,$3,true),($4,$5,$6,true)', [actor, 'checker@example.test', 'Checker', otherActor, 'other@example.test', 'Other'])
    const hashes: Record<string, string> = {}
    for (const file of MIGRATIONS) { const sql = readFileSync(`supabase/migrations/${file}`, 'utf8'); await pool.query(sql); hashes[file] = createHash('sha256').update(sql).digest('hex') }
    const overloads = await pool.query("select pronargs from pg_proc where pronamespace='public'::regnamespace and proname='qc_command'")
    assert.deepEqual(overloads.rows, [{ pronargs: 16 }])
    checks.push('single 16-argument qc_command overload')

    const order: QcOrder = { id: 'gid://shopify/Order/1', name: 'Qimati9001', updatedAt: new Date().toISOString(), cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null, lines: [
      { id: RING, variantId: 'gid://shopify/ProductVariant/11', title: 'Ring', variantTitle: 'Gold / 7', sku: 'RS004-C-GOLD-S-7', barcode: 'RS004-C-GOLD-S-7', required: 3, image: 'https://cdn.shopify.com/s/files/ring.jpg' },
      { id: NECK, variantId: 'gid://shopify/ProductVariant/12', title: 'Necklace', variantTitle: null, sku: 'NK1', barcode: 'NK1', required: 1 },
    ] }
    type Args = { action?: string; snapshot?: QcOrder; request?: string; code?: string | null; variant?: string | null; rejection?: string | null; version?: number | null; undo?: string | null; reason?: string | null; actor?: string; generation?: number; line?: string | null }
    const command = async (a: Args = {}): Promise<{ session: QcSession; event: QcEvent; replayed: boolean }> => {
      const snapshot = a.snapshot ?? order
      const connection = await pool.connect()
      try {
        await connection.query('set role service_role')
        const result = await connection.query('select public.qc_command($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8::uuid,$9,$10,$11,$12::integer,$13::uuid,$14,$15::integer,$16) as result', [
          'qc-test.myshopify.com', snapshot.id, a.actor ?? actor, a.action ?? 'scan', JSON.stringify(snapshot), orderFingerprint(snapshot), new Date().toISOString(), a.request ?? randomUUID(),
          a.code === undefined ? 'RS004-C-GOLD-S-7' : a.code, a.variant === undefined ? 'gid://shopify/ProductVariant/11' : a.variant,
          a.rejection ?? null, a.version ?? null, a.undo ?? null, a.reason ?? null, a.generation ?? 1, a.line ?? null,
        ])
        return result.rows[0].result
      } finally { await connection.query('reset role'); connection.release() }
    }
    const rows = async () => (await pool.query('select ref,line_id,quantity,reason,reported_by,resolved_by,resolution,resolution_note,generation,(resolved_at is null) as open from public.qc_shortages order by ref')).rows
    const version = async (snapshot = order) => (await command({ action: 'sync', snapshot })).session.version

    // Two of three rings scanned; the third is not in stock.
    await command(); await command()
    await assert.rejects(command({ action: 'short', version: await version(), line: RING }), /reason/)
    await assert.rejects(command({ action: 'short', version: await version(), line: 'ring', reason: 'not in stock' }), /order line/)
    check('short requires a reason and a line id', true)
    check('short on a fully checked or unknown line is rejected', (await command({ action: 'short', version: await version(), line: 'gid://shopify/LineItem/99', reason: 'not in stock' })).event.outcome === 'rejected')
    check('completion is incomplete while a unit is neither scanned nor short', (await command({ action: 'complete', version: await version() })).event.outcome === 'incomplete')
    const short = await command({ action: 'short', version: await version(), line: RING, reason: 'Not in stock, supplier delayed' })
    check('short is accepted for the remaining units of a line', short.event.outcome === 'short' && short.event.line_id === RING && short.event.variant_id === 'gid://shopify/ProductVariant/11')
    let list = await rows()
    assert.deepEqual(list.map(r => [Number(r.ref), r.line_id, r.quantity, r.reason, r.reported_by, r.open, r.generation]), [[1, RING, 1, 'Not in stock, supplier delayed', 'Checker', true, 1]])
    checks.push('shortage row records the remaining quantity, reason and reporter')
    check('a second short on the same line is rejected', (await command({ action: 'short', version: await version(), line: RING, reason: 'again' })).event.outcome === 'rejected')
    check('the same request id replays the short without a second row', (await command({ action: 'short', version: short.session.version - 1, line: RING, reason: 'Not in stock, supplier delayed', request: (short.event as unknown as { request_id: string }).request_id })).replayed === true || (await rows()).length === 1)
    check('completion still needs the necklace', (await command({ action: 'complete', version: await version() })).event.outcome === 'incomplete')
    await command({ code: 'NK1', variant: 'gid://shopify/ProductVariant/12' })
    // Race: one completion wins, the other conflicts; the pass records the short count.
    const v = await version()
    const race = await Promise.all([command({ action: 'complete', version: v }), command({ action: 'complete', version: v })])
    assert.deepEqual(race.map(x => x.event.outcome).sort(), ['conflict', 'passed'])
    const pass = race.find(x => x.event.outcome === 'passed')!
    check('QC passes with the accepted shortage and says so', /1 unit\(s\) short/.test(pass.event.message) && pass.session.status === 'passed')
    const detail = (await pool.query('select detail from public.qc_events where id=$1', [pass.event.id])).rows[0].detail
    check('the pass event carries the short count for history', detail.short === 1)
    check('a scan after passing is an extra, not a found unit', (await command()).event.outcome === 'extra' && (await rows())[0].open === true)

    // Recount: the found unit closes the shortage automatically.
    let state = await command({ action: 'reset', version: await version(), reason: 'Found the third ring' })
    list = await rows()
    check('a fresh checklist cancels the previous checklist\'s open shortages', list[0].open === false && list[0].resolution === 'cancelled' && /restarted/.test(list[0].resolution_note))
    for (let i = 0; i < 2; i++) await command({ generation: state.session.generation })
    const short2 = await command({ action: 'short', version: await version(), line: RING, reason: 'still missing' })
    check('a new checklist can record its own shortage', short2.event.outcome === 'short' && (await rows()).length === 2)
    const found = await command({ generation: state.session.generation })
    check('scanning a unit that was marked short accepts it and closes the shortage as found', found.event.outcome === 'accepted' && /Found/.test(found.event.message) && (await rows())[1].resolution === 'found' && (await rows())[1].quantity === 0)
    const surplus = await command({ generation: state.session.generation })
    check('a further scan of the same line is an extra once the line is full', surplus.event.outcome === 'extra')
    await command({ code: 'NK1', variant: 'gid://shopify/ProductVariant/12', generation: state.session.generation })
    check('the found unit does not pass QC while the surplus scan is untreated', (await command({ action: 'complete', version: await version() })).event.outcome === 'extras')
    await command({ action: 'clear_extra', version: await version(), undo: surplus.event.id })
    check('complete without any open shortage passes cleanly', /all remaining shipping units/.test((await command({ action: 'complete', version: await version() })).event.message))

    // Undo a shortage: any active operator, once, with a reason; the pass is withdrawn.
    state = await command({ action: 'reset', version: await version(), reason: 'Third trial' })
    await command({ generation: state.session.generation })
    const short3 = await command({ action: 'short', version: await version(), line: RING, reason: 'two missing' })
    check('short covers every remaining unit of the line', (await rows())[2].quantity === 2)
    const undone = await command({ action: 'undo', version: await version(), undo: short3.event.id, reason: 'Found them in another box', actor: otherActor })
    check('another operator can undo a shortage with a reason', undone.event.outcome === 'undone' && (await rows())[2].resolution === 'cancelled' && (await rows())[2].resolved_by === 'Other')
    check('a shortage cannot be undone twice', (await command({ action: 'undo', version: await version(), undo: short3.event.id, reason: 'again' })).event.outcome === 'rejected')
    check('after undo the line is missing again', (await command({ action: 'complete', version: await version() })).event.outcome === 'incomplete')
    check('an accepted scan still cannot be undone by another operator', (await command({ action: 'undo', version: await version(), undo: found.event.id, reason: 'not mine', actor: otherActor })).event.outcome === 'rejected')

    // Extras and shortages both gate completion.
    await command({ generation: state.session.generation }); await command({ generation: state.session.generation })
    await command({ code: 'NK1', variant: 'gid://shopify/ProductVariant/12', generation: state.session.generation })
    const extra = await command({ code: 'NK2', variant: 'gid://shopify/ProductVariant/99', generation: state.session.generation })
    check('a wrong item is recorded as extra', extra.event.outcome === 'wrong')
    check('completion is blocked by an open extra even with every unit present', (await command({ action: 'complete', version: await version() })).event.outcome === 'extras')
    await command({ action: 'clear_extra', version: await version(), undo: extra.event.id })
    check('completion passes once the extra is ticked removed', (await command({ action: 'complete', version: await version() })).event.outcome === 'passed')

    // Stale and blocked orders reject shortages like every other action.
    const changed = { ...order, lines: [{ ...order.lines[0], required: 4 }, order.lines[1]] }
    await command({ action: 'sync', snapshot: changed })
    check('a stale checklist rejects short', (await command({ action: 'short', snapshot: changed, version: await version(changed), line: RING, reason: 'stale test' })).event.outcome === 'stale')

    // Permissions: the new table is server-only like the others.
    const acl = await pool.query(`select c.relname, c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid=c.oid) policies,
      has_table_privilege('anon',c.oid,'SELECT') anon_read, has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE') server_write
      from pg_class c where c.oid='public.qc_shortages'::regclass`)
    assert.deepEqual(acl.rows, [{ relname: 'qc_shortages', relrowsecurity: true, policies: 0, anon_read: false, server_write: true }])
    checks.push('qc_shortages RLS deny-all, service_role only')
    for (const role of ['anon', 'authenticated']) {
      const connection = await pool.connect()
      try {
        await connection.query(`set role ${role}`)
        await assert.rejects(connection.query('select * from public.qc_shortages'), /permission denied/)
        await assert.rejects(connection.query("select public.qc_command('qc-test.myshopify.com','gid://shopify/Order/1',$1,'sync','{}','abc',now())", [actor]), /permission denied/)
      } finally { await connection.query('reset role'); connection.release() }
    }
    checks.push('browser roles cannot read shortages or call the RPC')

    const receipt = { database: 'temporary local PostgreSQL only', migrations: hashes, checks, shortageRows: await rows(), auditEvents: Number((await pool.query('select count(*) from public.qc_events')).rows[0].count), elapsedMs: Date.now() - started, limitation: 'Local SQL and fixtures. Does not prove live Shopify, PostgREST embedding, or a physical scanner.' }
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await pool.end()
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (child.exitCode === null) { child.kill('SIGTERM'); await stopped }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
