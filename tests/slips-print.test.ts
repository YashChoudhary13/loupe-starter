import { describe, expect, it, vi } from 'vitest'
import { NothingToPrint, printSlips, retryProgress, select, type PrintDeps } from '@/lib/slips/print'
import type { SlipOrder } from '@/lib/slips/types'

const order = (n: number, changes: Partial<SlipOrder> = {}, phone = `90000000${String(n).padStart(2, '0')}`): SlipOrder => ({
  id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-10-10T05:00:00Z', note: null, tags: [], email: null, phone, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', total: 100, customer: null, billingAddress: null,
  shippingAddress: { name: `Buyer ${n}`, phone: null, address1: `${n} Main St`, address2: null, city: 'Jaipur', provinceCode: null, zip: '302001', country: null },
  fulfillmentOrders: [{ id: `gid://shopify/FulfillmentOrder/${n}`, status: 'OPEN', holdReasons: [] }],
  lines: [{ title: 'Ring', variantTitle: null, sku: 'RS1', quantity: 2, unfulfilledQuantity: 2, requiresShipping: true, imageUrl: null }], ...changes,
})
const held = (n: number) => order(n, { fulfillmentStatus: 'ON_HOLD', fulfillmentOrders: [{ id: `gid://shopify/FulfillmentOrder/${n}`, status: 'ON_HOLD', holdReasons: ['other'] }] })

function fakeDeps(orders: SlipOrder[], options: { printed?: string[]; taken?: string[]; failOn?: string[]; truncated?: boolean } = {}) {
  const calls = { batches: [] as unknown[], rows: [] as unknown[], progress: [] as unknown[], reported: [] as string[], events: [] as unknown[] }
  const deps: PrintDeps = {
    listOpenOrders: async () => ({ orders, truncated: !!options.truncated }),
    readOrders: async ids => orders.filter(o => ids.includes(o.id)),
    printedOrderIds: async ids => new Set((options.printed ?? []).filter(id => ids.includes(id))),
    createBatch: async input => { calls.batches.push(input); return 'b1' },
    insertRows: async (batchId, rows) => { calls.rows.push(...rows.map(row => ({ batchId, ...row }))); return new Set(rows.map(row => row.orderId).filter(id => !(options.taken ?? []).includes(id))) },
    finishBatch: vi.fn(async () => {}),
    setProgress: async (batchId, orderId, progress, error) => { calls.progress.push({ orderId, progress, error }) },
    reportProgress: async id => { if ((options.failOn ?? []).includes(id)) throw new Error('Shopify refused.'); calls.reported.push(id) },
    record: async (batchId, event, detail) => { calls.events.push({ event, detail }) },
  }
  return { deps, calls }
}
const ids = (rows: { orderId: string }[]) => rows.map(row => row.orderId.replace('gid://shopify/Order/', ''))

describe('select: what one click would print', () => {
  it('skips orders that already have a slip, keeps them as CLUB links, and leaves unpaid orders out by name', async () => {
    const orders = [order(1), order(2, {}, '9000000001'), order(3, { financialStatus: 'PENDING' })]
    const { deps } = fakeDeps(orders, { printed: ['gid://shopify/Order/1'] })
    const selection = await select(deps, null)
    expect(selection.rows.map(row => row.order.name)).toEqual(['Qimati2'])
    expect(selection.rows[0].strip.detail).toBe('put in 1 parcel; with 1 (older, unfulfilled)')
    expect(selection.leftOut).toEqual(['Qimati3 (pending)']); expect(selection.unprinted).toBe(1)
  })
  it('with a start number, prints from it and lists the older unprinted paid orders as baseline', async () => {
    const { deps } = fakeDeps([order(5), order(6), order(7), order(4, { financialStatus: 'PENDING' })])
    const selection = await select(deps, 6)
    expect(selection.rows.map(row => row.order.name)).toEqual(['Qimati6', 'Qimati7'])
    expect(selection.baseline.map(o => o.name)).toEqual(['Qimati5']); expect(selection.leftOut).toEqual([])
  })
})

describe('printSlips', () => {
  it('records the batch and rows, then marks only PACK and CLUB orders In progress through their OPEN fulfilment orders', async () => {
    const already = order(3, { fulfillmentOrders: [{ id: 'fo3', status: 'IN_PROGRESS', holdReasons: [] }] })
    const twoLocations = order(4, { fulfillmentOrders: [{ id: 'fo4a', status: 'OPEN', holdReasons: [] }, { id: 'fo4b', status: 'CLOSED', holdReasons: [] }] })
    const { deps, calls } = fakeDeps([order(1), held(2), already, twoLocations])
    const outcome = await printSlips('owner', null, deps)
    expect(outcome).toMatchObject({ batchId: 'b1', printed: 4, baseline: 0, marks: { PACK: 3, HOLD: 1, CLUB: 0, 'CLUB + HOLD': 0 }, failed: [] })
    expect(calls.batches).toEqual([{ by: 'owner', fromNumber: null }])
    expect(ids(calls.rows as { orderId: string }[])).toEqual(['1', '2', '3', '4'])
    expect(calls.reported).toEqual(['gid://shopify/FulfillmentOrder/1', 'fo4a'])
    expect(calls.progress).toEqual([
      { orderId: 'gid://shopify/Order/1', progress: 'marked', error: null }, { orderId: 'gid://shopify/Order/2', progress: 'not_needed', error: null },
      { orderId: 'gid://shopify/Order/3', progress: 'already', error: null }, { orderId: 'gid://shopify/Order/4', progress: 'marked', error: null }])
    expect(deps.finishBatch).toHaveBeenCalledWith('b1', 4)
    expect(calls.events[0]).toMatchObject({ event: 'slips.printed', detail: { printed: 4, failed: [], skippedAsTaken: 0 } })
  })
  it('keeps a Shopify failure on the row and in the outcome, and goes on with the next order', async () => {
    const { deps, calls } = fakeDeps([order(1), order(2)], { failOn: ['gid://shopify/FulfillmentOrder/1'] })
    const outcome = await printSlips('owner', null, deps)
    expect(outcome.failed).toEqual([{ name: 'Qimati1', error: 'Shopify refused.' }]); expect(outcome.printed).toBe(2)
    expect(calls.progress[0]).toEqual({ orderId: 'gid://shopify/Order/1', progress: 'failed', error: 'Shopify refused.' })
    expect(calls.reported).toEqual(['gid://shopify/FulfillmentOrder/2'])
  })
  it('leaves out an order another click took meanwhile: not printed, not marked', async () => {
    const { deps, calls } = fakeDeps([order(1), order(2)], { taken: ['gid://shopify/Order/2'] })
    const outcome = await printSlips('owner', null, deps)
    expect(outcome.printed).toBe(1); expect(calls.reported).toEqual(['gid://shopify/FulfillmentOrder/1'])
    expect(calls.events[0]).toMatchObject({ detail: { skippedAsTaken: 1 } }); expect(deps.finishBatch).toHaveBeenCalledWith('b1', 1)
  })
  it('records baseline rows below the start number without printing or marking them', async () => {
    const { deps, calls } = fakeDeps([order(5), order(6)])
    const outcome = await printSlips('owner', 6, deps)
    expect(outcome).toMatchObject({ printed: 1, baseline: 1 })
    expect(calls.rows).toContainEqual(expect.objectContaining({ orderId: 'gid://shopify/Order/5', mark: 'BASELINE' }))
    expect(calls.reported).toEqual(['gid://shopify/FulfillmentOrder/6']); expect(calls.progress).toHaveLength(1)
  })
  it('creates nothing when there is nothing to print, and names the unpaid orders', async () => {
    const { deps, calls } = fakeDeps([order(1, { financialStatus: 'PENDING' })])
    await expect(printSlips('owner', null, deps)).rejects.toThrow(NothingToPrint)
    await expect(printSlips('owner', null, deps)).rejects.toThrow(/Qimati1 \(pending\)/)
    expect(calls.batches).toEqual([])
  })
  it('refuses an incomplete order list', async () => {
    const { deps, calls } = fakeDeps([order(1)], { truncated: true })
    await expect(printSlips('owner', null, deps)).rejects.toThrow(/incomplete/)
    expect(calls.batches).toEqual([])
  })
})

describe('retryProgress', () => {
  it('marks again only the failed rows and reports what still fails', async () => {
    const { deps, calls } = fakeDeps([order(1), order(2)], { failOn: ['gid://shopify/FulfillmentOrder/2'] })
    const rows = [{ order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', mark: 'PACK' as const, progress: 'failed' as const }, { order_id: 'gid://shopify/Order/2', order_name: 'Qimati2', mark: 'PACK' as const, progress: 'failed' as const }, { order_id: 'gid://shopify/Order/3', order_name: 'Qimati3', mark: 'PACK' as const, progress: 'marked' as const }, { order_id: 'gid://shopify/Order/9', order_name: 'Qimati9', mark: 'PACK' as const, progress: 'failed' as const }]
    const result = await retryProgress('b1', rows, 'owner', deps)
    expect(result).toEqual({ fixed: 1, failed: [{ name: 'Qimati2', error: 'Shopify refused.' }, { name: 'Qimati9', error: 'Shopify could not return this order.' }] })
    expect(calls.reported).toEqual(['gid://shopify/FulfillmentOrder/1'])
    expect(calls.progress.map(p => (p as { progress: string }).progress)).toEqual(['marked', 'failed', 'failed'])
  })
  it('does nothing when no row failed', async () => {
    const { deps, calls } = fakeDeps([order(1)])
    expect(await retryProgress('b1', [{ order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', mark: 'PACK', progress: 'marked' }], 'owner', deps)).toEqual({ fixed: 0, failed: [] })
    expect(calls.events).toEqual([])
  })
})
