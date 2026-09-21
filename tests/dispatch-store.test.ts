import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ queue: [] as { data?: unknown; error?: unknown }[], calls: [] as { table: string; method: string; args: unknown[] }[] }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { config = { storeDomain: 'dispatch-test.myshopify.com' } } }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: (table: string) => {
  const next = () => Promise.resolve(db.queue.shift() ?? { data: null, error: null })
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'or', 'gte', 'gt', 'order', 'limit']) builder[method] = (...args: unknown[]) => { db.calls.push({ table, method, args }); return builder }
  builder.maybeSingle = next; builder.single = next
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => next().then(resolve, reject)
  return builder
} }) }))
import { groupOrder, listParcels, stageTracking, supabasePushStore } from '@/lib/dispatch/store'

const did = (table: string, method: string) => db.calls.filter(call => call.table === table && call.method === method)
const solo = { id: 'p1', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders: [{ id: 'r1', parcel_id: 'p1', order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', position: 0, status: 'staged', fulfillment_id: null, error: null, push_started_at: null, finished_at: null }] }
beforeEach(() => { db.queue.length = 0; db.calls.length = 0 })

describe('staging', () => {
  it('rejects a bad number before touching the database', async () => {
    await expect(stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: 'x1-2', by: 'op' })).rejects.toThrow(/6 to 30|letters and digits/)
    expect(db.calls).toEqual([])
  })
  it('creates a parcel and its first order, normalised, with the detected carrier', async () => {
    db.queue.push({ data: null }, { data: { id: 'p1' } }, { error: null }, { error: null })
    await stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: ' x1234 567 ', by: 'op@example.test' })
    expect(did('dispatch_parcels', 'insert')[0].args[0]).toMatchObject({ shop_domain: 'dispatch-test.myshopify.com', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op@example.test' })
    expect(did('dispatch_parcel_orders', 'insert')[0].args[0]).toMatchObject({ parcel_id: 'p1', order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', position: 0 })
    expect(did('events', 'insert')[0].args[0]).toMatchObject({ event: 'dispatch.staged', actor: 'op@example.test' })
  })
  it('deletes a lone, never-pushed parcel when its number is cleared', async () => {
    db.queue.push({ data: { id: 'r1', parcel_id: 'p1', position: 0, status: 'staged' } }, { data: solo }, { error: null })
    await stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: '', by: 'op' })
    expect(did('dispatch_parcels', 'delete')).toHaveLength(1); expect(did('dispatch_parcels', 'update')).toHaveLength(0)
  })
  it('keeps a grouped parcel when its number is cleared', async () => {
    const grouped = { ...solo, orders: [...solo.orders, { ...solo.orders[0], id: 'r2', order_id: 'gid://shopify/Order/2', order_name: 'Qimati2', position: 1 }] }
    db.queue.push({ data: { id: 'r1', parcel_id: 'p1', position: 0, status: 'staged' } }, { data: grouped }, { error: null })
    await stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: '', by: 'op' })
    expect(did('dispatch_parcels', 'delete')).toHaveLength(0)
    expect(did('dispatch_parcels', 'update')[0].args[0]).toMatchObject({ tracking_number: null, carrier: null })
  })
  it('refuses edits while the parcel is being pushed', async () => {
    db.queue.push({ data: { id: 'r1', parcel_id: 'p1', position: 0, status: 'pushing' } }, { data: { ...solo, orders: [{ ...solo.orders[0], status: 'pushing' }] } })
    await expect(stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: 'X7654321', by: 'op' })).rejects.toThrow(/being pushed/)
  })
})
describe('listing', () => {
  it('shows a push interrupted more than two minutes ago as failed, so it can be pushed again', async () => {
    const stuck = { ...solo, orders: [{ ...solo.orders[0], status: 'pushing', push_started_at: '2026-09-21T05:00:00Z' }] }
    const fresh = { ...solo, id: 'p2', orders: [{ ...solo.orders[0], id: 'r2', parcel_id: 'p2', status: 'pushing', push_started_at: new Date().toISOString() }] }
    db.queue.push({ data: [{ parcel_id: 'p1' }, { parcel_id: 'p2' }] }, { data: [stuck, fresh] }, { data: [] })
    const { open } = await listParcels()
    expect(open[0].orders[0]).toMatchObject({ status: 'failed' }); expect(open[0].orders[0].error).toMatch(/interrupted/)
    expect(open[1].orders[0].status).toBe('pushing')
  })
})
describe('grouping and claiming', () => {
  it('refuses to group an order with itself', async () => { await expect(groupOrder({ primaryOrderId: '1', primaryOrderName: 'Qimati1', orderId: '1', orderName: 'Qimati1', by: 'op' })).rejects.toThrow(/itself/) })
  it('claims staged, failed, or a push stuck for two minutes — nothing else', async () => {
    db.queue.push({ data: { id: 'r1' } })
    expect(await supabasePushStore().claim('r1', 'req-1', new Date('2026-09-21T06:02:00.000Z'))).toBe(true)
    expect(did('dispatch_parcel_orders', 'or')[0].args[0]).toBe('status.in.(staged,failed),and(status.eq.pushing,push_started_at.lt."2026-09-21T06:00:00.000Z")')
    db.queue.push({ data: null })
    expect(await supabasePushStore().claim('r1', 'req-2', new Date())).toBe(false)
  })
})
