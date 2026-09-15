/** Isolated transaction/RLS proof. No .env files or network connections are used. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { orderFingerprint } from '../src/lib/qc/snapshot'
import type { QcOrder, QcEvent, QcSession } from '../src/lib/qc/types'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-qc-db-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_qc_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55438', '-N', '40'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55438, user: 'loupe_qc_test', database: 'postgres', max: 20 })
  try {
    for (let attempt = 0; ; attempt++) {
      try { await pool.query('select 1'); break }
      catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) }
    }
    const actor = randomUUID(), otherActor = randomUUID(), inactive = randomUUID()
    await pool.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.app_users(id uuid primary key, email text, name text, active boolean);
      grant select on public.app_users to service_role;`)
    await pool.query('insert into public.app_users values($1,$2,$3,true),($4,$5,$6,true),($7,$8,$9,false)', [actor,'checker@example.test','Checker',otherActor,'other@example.test','Other',inactive,'inactive@example.test','Inactive'])
    const migration = readFileSync('supabase/migrations/20260915081237_order_qc_sessions.sql', 'utf8')
    await pool.query(migration)
    const order: QcOrder = { id: 'gid://shopify/Order/1', name: 'TEST ONLY', updatedAt: new Date().toISOString(), cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null,
      lines: [{ id: 'gid://shopify/LineItem/1', variantId: 'gid://shopify/ProductVariant/11', title: 'Ring', variantTitle: 'Gold / 7', sku: 'RS004-C-GOLD-S-7', barcode: 'RS004-C-GOLD-S-7', required: 12 }] }
    type Args = { action?: string; snapshot?: QcOrder; request?: string; code?: string | null; variant?: string | null; rejection?: string | null; version?: number | null; undo?: string | null; reason?: string | null; actor?: string; checkedAt?: string; generation?: number }
    const command = async (a: Args = {}): Promise<{ session: QcSession; event: QcEvent; replayed: boolean }> => {
      const snapshot = a.snapshot ?? order
      const connection = await pool.connect()
      try {
        await connection.query('set role service_role')
        const result = await connection.query('select public.qc_command($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8::uuid,$9,$10,$11,$12::integer,$13::uuid,$14,$15::integer) as result', [
          'qc-test.myshopify.com', snapshot.id, a.actor ?? actor, a.action ?? 'scan', JSON.stringify(snapshot), orderFingerprint(snapshot), a.checkedAt ?? new Date().toISOString(), a.request ?? randomUUID(),
          a.code === undefined ? 'RS004-C-GOLD-S-7' : a.code, a.variant === undefined ? 'gid://shopify/ProductVariant/11' : a.variant,
          a.rejection ?? null, a.version ?? null, a.undo ?? null, a.reason ?? null, a.generation ?? 1,
        ])
        return result.rows[0].result
      } finally { await connection.query('reset role'); connection.release() }
    }
    const started = Date.now()
    const scans = await Promise.all(Array.from({ length: 100 }, () => command()))
    assert.equal(scans.filter(x => x.event.outcome === 'accepted').length, 12)
    assert.equal(scans.filter(x => x.event.outcome === 'extra').length, 88)
    let state = await command({ action: 'sync' })
    assert.equal(state.session.counts[order.lines[0].id], 12)
    assert.equal(state.session.version, 12)
    const wrong = await command({ variant: 'gid://shopify/ProductVariant/12', code: 'WRONG-SIZE' })
    assert.equal(wrong.event.outcome, 'wrong')
    const reject = await command({ variant: null, rejection: 'Ambiguous code.' })
    assert.equal(reject.event.outcome, 'rejected')
    const passRace = await Promise.all([command({ action: 'complete', version: state.session.version }), command({ action: 'complete', version: state.session.version })])
    assert.deepEqual(passRace.map(x => x.event.outcome).sort(), ['conflict','passed'])
    state = await command({ action: 'sync' })
    assert.equal(state.session.status, 'passed')
    const changed = { ...order, lines: [{ ...order.lines[0], required: 13 }] }
    state = await command({ action: 'sync', snapshot: changed })
    assert.equal(state.session.status, 'stale')
    assert.equal(state.session.completed_at, null)
    assert.equal(state.session.counts[order.lines[0].id], 12)
    assert.equal((await command({ snapshot: changed })).event.outcome, 'stale')
    // Returning to old quantities must not resurrect a previously passed checklist.
    assert.equal((await command({ action: 'sync' })).session.status, 'stale')
    state = await command({ action: 'reset', snapshot: changed, version: state.session.version, reason: 'Order quantity changed' })
    assert.equal(state.session.generation, 2)
    assert.deepEqual(state.session.counts, {})
    assert.equal((await command({ snapshot: changed, generation: 1 })).event.outcome, 'conflict')
    assert.deepEqual((await command({ action: 'sync', snapshot: changed })).session.counts, {})
    const request = randomUUID()
    const retries = await Promise.all(Array.from({ length: 40 }, () => command({ snapshot: changed, generation: 2, request })))
    assert.equal(retries.filter(x => !x.replayed).length, 1)
    assert.equal(new Set(retries.map(x => x.event.id)).size, 1)
    assert.equal(retries.at(-1)!.session.counts[order.lines[0].id], 1)
    await assert.rejects(command({ snapshot: changed, generation: 2, request, code: 'different' }), /already used/)
    state = await command({ action: 'sync', snapshot: changed })
    assert.equal((await command({ action: 'complete', snapshot: changed, version: state.session.version })).event.outcome, 'incomplete')
    assert.equal((await command({ action: 'undo', snapshot: changed, version: state.session.version, undo: retries[0].event.id, reason: 'Accidental scan', actor: otherActor })).event.outcome, 'rejected')
    const undone = await command({ action: 'undo', snapshot: changed, version: state.session.version, undo: retries[0].event.id, reason: 'Accidental scan' })
    assert.equal(undone.event.outcome, 'undone')
    assert.equal(undone.session.counts[order.lines[0].id], 0)
    assert.equal((await command({ action: 'undo', snapshot: changed, version: undone.session.version, undo: retries[0].event.id, reason: 'Accidental scan' })).event.outcome, 'rejected')
    const canceled = { ...changed, cancelledAt: new Date().toISOString(), blockedReason: 'This order is cancelled. Do not pack it.' }
    state = await command({ action: 'sync', snapshot: canceled })
    assert.equal(state.session.status, 'stale')
    assert.equal((await command({ action: 'reset', snapshot: canceled, version: state.session.version, reason: 'Cannot pack canceled order' })).event.outcome, 'blocked')
    await assert.rejects(command({ actor: inactive }), /active Loupe operator/)
    await assert.rejects(command({ checkedAt: new Date(Date.now() - 60000).toISOString() }), /expired/)
    const duplicate: QcOrder = { ...order, id: 'gid://shopify/Order/2', lines: [
      { ...order.lines[0], id: 'gid://shopify/LineItem/10', required: 2 },
      { ...order.lines[0], id: 'gid://shopify/LineItem/20', required: 1 },
    ] }
    const distributed = []
    for (let i = 0; i < 4; i++) distributed.push(await command({ snapshot: duplicate }))
    assert.deepEqual(distributed.map(x => x.event.line_id), ['gid://shopify/LineItem/10','gid://shopify/LineItem/10','gid://shopify/LineItem/20',null])
    assert.equal(distributed[3].event.outcome, 'extra')
    const acl = await pool.query(`select c.relname, c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid=c.oid) policies from pg_class c where c.oid in ('public.qc_sessions'::regclass,'public.qc_events'::regclass) order by relname`)
    assert.deepEqual(acl.rows, [{ relname: 'qc_events', relrowsecurity: true, policies: 0 }, { relname: 'qc_sessions', relrowsecurity: true, policies: 0 }])
    for (const role of ['anon','authenticated']) {
      const connection = await pool.connect()
      try {
        await connection.query(`set role ${role}`)
        await assert.rejects(connection.query('select * from public.qc_sessions'), /permission denied/)
        await assert.rejects(connection.query("select public.qc_command('qc-test.myshopify.com','gid://shopify/Order/1',$1,'sync','{}','abc',now())", [actor]), /permission denied/)
      } finally { await connection.query('reset role'); connection.release() }
    }
    const eventCount = Number((await pool.query('select count(*) from public.qc_events')).rows[0].count)
    const receipt = { database: 'temporary local PostgreSQL only', migrationSha256: createHash('sha256').update(migration).digest('hex'), concurrentScans: 100, accepted: 12, excessRejected: 88, connections: 20, repeatedRequests: 40, repeatedRequestCounted: 1, checks: ['remaining quantity cap','wrong variant','ambiguous code rejection','completion race','order edit invalidation','sticky stale state','reset preserves history','UUID payload conflict','scan from pre-reset generation rejected','incomplete completion','own scan undo','double undo rejection','cancelled order','inactive operator','expired snapshot','duplicate-variant line distribution','RLS deny all','RPC inaccessible to browser roles'], auditEvents: eventCount, elapsedMs: Date.now() - started, temporaryDataDirectory: join(root,'data'), limitation: 'Local SQL and fixtures. Does not prove live Shopify or a physical scanner.' }
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(receipt, null, 2)+'\n')
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await pool.end()
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (child.exitCode === null) { child.kill('SIGTERM'); await stopped }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
