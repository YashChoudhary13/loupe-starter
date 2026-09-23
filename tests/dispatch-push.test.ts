import { describe, expect, it, vi } from 'vitest'
import { pushParcel, type PushDeps, type PushExpectation, type PushStore } from '@/lib/dispatch/push'
import type { DispatchOrderSnapshot, ParcelOrderRow, ParcelRow } from '@/lib/dispatch/types'

const row = (n: number, changes: Partial<ParcelOrderRow> = {}): ParcelOrderRow => ({ id: `r${n}`, parcel_id: 'p1', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position: n - 1, status: 'staged', fulfillment_id: null, error: null, push_started_at: null, finished_at: null, ...changes })
const parcelOf = (orders: ParcelOrderRow[], changes: Partial<ParcelRow> = {}): ParcelRow => ({ id: 'p1', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op@example.test', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders, ...changes })
const snapshot = (n: number, changes: Partial<DispatchOrderSnapshot> = {}): DispatchOrderSnapshot => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, closed: false, cancelledAt: null, fulfillmentOrdersComplete: true, fulfillments: [], fulfillmentOrders: [{ id: `fo${n}`, status: 'IN_PROGRESS', canFulfil: true, remaining: 2, locationId: 'loc1', complete: true }], ...changes })

function harness(parcel: ParcelRow, shopify: Record<string, DispatchOrderSnapshot>, fulfilBehaviour: 'lands' | 'throws-but-lands' | 'throws' | 'silent' = 'lands') {
  const events: string[] = []
  const find = (id: string) => parcel.orders.find(item => item.id === id)!
  const store: PushStore = {
    loadParcel: async () => parcel,
    claim: async id => { const item = find(id); if (item.status === 'pushing' || item.status === 'fulfilled') return false; item.status = 'pushing'; return true },
    fail: async (id, message) => { Object.assign(find(id), { status: 'failed', error: message }) },
    finish: async (id, _request, result) => { Object.assign(find(id), 'fulfillmentId' in result ? { status: 'fulfilled', fulfillment_id: result.fulfillmentId, error: null } : { status: 'failed', error: result.error }) },
    markPushed: async (_id, by, now) => { parcel.pushed_by = by; parcel.pushed_at = now.toISOString() },
    record: async (_id, event) => { events.push(event) },
  }
  const land = (input: { fulfillmentOrderIds: readonly string[]; company: string; number: string }) => {
    const order = Object.values(shopify).find(item => item.fulfillmentOrders.some(fo => input.fulfillmentOrderIds.includes(fo.id)))!
    order.fulfillments.push({ id: `f-${order.name}`, status: 'SUCCESS', tracking: [{ company: input.company, number: input.number }] })
    for (const fo of order.fulfillmentOrders) if (input.fulfillmentOrderIds.includes(fo.id)) Object.assign(fo, { status: 'CLOSED', remaining: 0 })
  }
  const fulfil = vi.fn(async (input: Parameters<PushDeps['fulfil']>[0]) => {
    if (fulfilBehaviour === 'lands' || fulfilBehaviour === 'throws-but-lands') land(input)
    if (fulfilBehaviour === 'throws' || fulfilBehaviour === 'throws-but-lands') throw new Error('Shopify timed out.')
    return { id: 'f-new' }
  })
  let n = 0
  const readOrder = vi.fn(async (id: string) => structuredClone(shopify[id]))
  const deps: PushDeps = { store, fulfil, readOrder, now: () => new Date('2026-09-21T06:00:00Z'), newId: () => `req-${++n}` }
  return { deps, fulfil, readOrder, events, parcel }
}
const two = () => ({ 'gid://shopify/Order/1': snapshot(1), 'gid://shopify/Order/2': snapshot(2) })
/** What the confirm sheet showed for this parcel: every non-fulfilled order, with the number and carrier on screen. */
const expectedOf = (parcel: ParcelRow, changes: Partial<PushExpectation> = {}): PushExpectation => ({ carrier: parcel.carrier!, tracking: parcel.tracking_number!, orderIds: parcel.orders.filter(item => item.status !== 'fulfilled').map(item => item.order_id), ...changes })

describe('pushParcel', () => {
  it('fulfils every order of a parcel with the shared number and records who pushed', async () => {
    const h = harness(parcelOf([row(1), row(2)]), two())
    const results = await pushParcel('p1', 'owner@example.test', h.deps, expectedOf(h.parcel))
    expect(results.map(r => [r.orderName, r.status])).toEqual([['Qimati1', 'fulfilled'], ['Qimati2', 'fulfilled']])
    expect(h.fulfil.mock.calls.map(([input]) => input)).toEqual([{ fulfillmentOrderIds: ['fo1'], company: 'DTDC', number: 'X1234567' }, { fulfillmentOrderIds: ['fo2'], company: 'DTDC', number: 'X1234567' }])
    expect(h.parcel.pushed_by).toBe('owner@example.test')
    expect(h.events).toEqual(['dispatch.pushed'])
  })
  it('re-asserts the carrier and number it actually sent when it records the push', async () => {
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) })
    const marked: Parameters<PushStore['markPushed']>[] = []
    h.deps.store.markPushed = async (...args) => { marked.push(args) }
    await pushParcel('p1', 'owner@example.test', h.deps, expectedOf(h.parcel))
    expect(marked).toEqual([['p1', 'owner@example.test', new Date('2026-09-21T06:00:00Z'), { carrier: 'DTDC', number: 'X1234567' }]])
  })
  it('fulfils nothing when any order of the parcel fails the pre-check', async () => {
    const h = harness(parcelOf([row(1), row(2)]), { ...two(), 'gid://shopify/Order/2': snapshot(2, { cancelledAt: '2026-09-21T01:00:00Z' }) })
    const results = await pushParcel('p1', 'owner@example.test', h.deps, expectedOf(h.parcel))
    expect(h.fulfil).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ orderName: 'Qimati1', status: 'failed' }); expect(results[0].message).toMatch(/Qimati2/)
    expect(results[1].message).toMatch(/cancelled/)
    expect(h.parcel.orders.map(o => o.status)).toEqual(['staged', 'failed'])
    expect(h.parcel.pushed_at).toBeNull(); expect(h.events).toEqual(['dispatch.failed'])
  })
  it('trusts the re-read, not the response: a lost response that landed is a success', async () => {
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) }, 'throws-but-lands')
    expect((await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel)))[0].status).toBe('fulfilled')
    expect(h.fulfil).toHaveBeenCalledTimes(1)
  })
  it('keeps the first order fulfilled when a later one fails, and leaves that one for another push', async () => {
    const shopify = two(); const h = harness(parcelOf([row(1), row(2)]), shopify)
    h.fulfil.mockImplementationOnce(h.fulfil.getMockImplementation()!).mockImplementationOnce(async () => { throw new Error('Shopify timed out.') })
    const results = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'failed']); expect(results[1].message).toMatch(/timed out/)
    expect(h.parcel.orders.map(o => o.status)).toEqual(['fulfilled', 'failed'])
    expect(h.parcel.pushed_at).not.toBeNull(); expect(h.events).toEqual(['dispatch.failed'])
  })
  it('does not call a push done until Shopify shows the fulfilment', async () => {
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) }, 'silent')
    const [result] = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(result.status).toBe('failed'); expect(result.message).toMatch(/did not confirm/)
  })
  it('stands aside for an order another push holds', async () => {
    const h = harness(parcelOf([row(1, { status: 'pushing' })]), { 'gid://shopify/Order/1': snapshot(1) })
    expect((await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel)))[0].status).toBe('busy'); expect(h.fulfil).not.toHaveBeenCalled()
  })
  it('records an order someone already fulfilled with the same number, without fulfilling again', async () => {
    const already = snapshot(1, { fulfillmentOrders: [{ id: 'fo1', status: 'CLOSED', canFulfil: false, remaining: 0, locationId: 'loc1', complete: true }], fulfillments: [{ id: 'f-admin', status: 'SUCCESS', tracking: [{ company: 'DTDC', number: 'X1234567' }] }] })
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': already })
    expect((await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel)))[0].status).toBe('fulfilled'); expect(h.fulfil).not.toHaveBeenCalled()
    expect(h.parcel.orders[0].fulfillment_id).toBe('f-admin')
  })
  it('refuses a parcel without a number or a carrier', async () => {
    const h = harness(parcelOf([row(1)], { carrier: null }), {})
    await expect(pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))).rejects.toThrow(/tracking number and carrier/)
  })
  it('does not let a failed audit write turn a completed fulfilment into an error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) })
    h.deps.store.record = async () => { throw new Error('audit db down') }
    const [result] = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(result.status).toBe('fulfilled')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
  it('reports a fulfilment Loupe could not save, and still processes the next order', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness(parcelOf([row(1), row(2)]), two())
    const realFinish = h.deps.store.finish
    let calls = 0
    h.deps.store.finish = async (...args: Parameters<PushStore['finish']>) => { calls++; if (calls === 1) throw new Error('save failed'); return realFinish(...args) }
    const results = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(h.fulfil).toHaveBeenCalledTimes(2)
    expect(results[0].message).toMatch(/could not save the result/)
    spy.mockRestore()
  })
  it('does not let a failed markPushed write turn a completed push into an error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) })
    h.deps.store.markPushed = async () => { throw new Error('markPushed failed') }
    const [result] = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(result.status).toBe('fulfilled')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
  it('does not let a failed pre-check write lose the refusal results', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness(parcelOf([row(1), row(2)]), { ...two(), 'gid://shopify/Order/2': snapshot(2, { cancelledAt: '2026-09-21T01:00:00Z' }) })
    h.deps.store.fail = async () => { throw new Error('fail write failed') }
    const results = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(h.fulfil).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ orderName: 'Qimati1', status: 'failed' })
    expect(results[1].message).toMatch(/cancelled/)
    spy.mockRestore()
  })
  it('keeps order 1 fulfilled, marks the push and audits it when the claim of order 2 throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness(parcelOf([row(1), row(2)]), two())
    const claim = h.deps.store.claim
    let calls = 0
    h.deps.store.claim = async (...args: Parameters<PushStore['claim']>) => { calls++; if (calls === 2) throw new Error('claim db down'); return claim(...args) }
    const marked: Parameters<PushStore['markPushed']>[] = []
    h.deps.store.markPushed = async (...args) => { marked.push(args) }
    const results = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel))
    expect(results.map(r => [r.orderName, r.status])).toEqual([['Qimati1', 'fulfilled'], ['Qimati2', 'failed']])
    expect(results[1].message).toBe('Loupe could not start this order, so nothing was sent for it. Push again.')
    expect(h.parcel.orders[0].status).toBe('fulfilled')
    expect(marked).toEqual([['p1', 'op', new Date('2026-09-21T06:00:00Z'), { carrier: 'DTDC', number: 'X1234567' }]])
    expect(h.events).toEqual(['dispatch.failed'])
    spy.mockRestore()
  })
})

describe('what the owner confirmed is checked before anything is read from Shopify', () => {
  const changed = 'This parcel changed on another screen. Reload Dispatch and check it before pushing.'
  const nothingTouched = (h: ReturnType<typeof harness>) => { expect(h.readOrder).not.toHaveBeenCalled(); expect(h.fulfil).not.toHaveBeenCalled() }
  it('refuses a number that changed after the sheet was drawn', async () => {
    const h = harness(parcelOf([row(1), row(2)]), two())
    await expect(pushParcel('p1', 'op', h.deps, expectedOf(h.parcel, { tracking: 'X7654321' }))).rejects.toThrow(changed)
    nothingTouched(h)
  })
  it('refuses a carrier that changed after the sheet was drawn', async () => {
    const h = harness(parcelOf([row(1), row(2)]), two())
    await expect(pushParcel('p1', 'op', h.deps, expectedOf(h.parcel, { carrier: 'India Post' }))).rejects.toThrow(changed)
    nothingTouched(h)
  })
  it('refuses a parcel that gained an order after the sheet was drawn', async () => {
    const h = harness(parcelOf([row(1), row(2)]), two())
    await expect(pushParcel('p1', 'op', h.deps, expectedOf(h.parcel, { orderIds: ['gid://shopify/Order/1'] }))).rejects.toThrow(changed)
    nothingTouched(h)
  })
  it('refuses a parcel that lost an order after the sheet was drawn', async () => {
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) })
    await expect(pushParcel('p1', 'op', h.deps, expectedOf(h.parcel, { orderIds: ['gid://shopify/Order/1', 'gid://shopify/Order/2'] }))).rejects.toThrow(changed)
    nothingTouched(h)
  })
  it('accepts the confirmed orders in any order', async () => {
    const h = harness(parcelOf([row(1), row(2)]), two())
    const results = await pushParcel('p1', 'op', h.deps, expectedOf(h.parcel, { orderIds: ['gid://shopify/Order/2', 'gid://shopify/Order/1'] }))
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
  })
})
