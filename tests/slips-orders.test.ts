import { describe, expect, it, vi } from 'vitest'
import { listOpenOrders, readOrders, reportProgress, slipShopifyError } from '@/lib/shopify/slip-orders'
import type { ShopifyClient } from '@/lib/shopify/client'

const client = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as ShopifyClient
const raw = (n: number, changes: Record<string, unknown> = {}, lines: unknown[] = [{ title: 'Ring', variantTitle: null, sku: 'RS1', quantity: 1, unfulfilledQuantity: 1, requiresShipping: true, image: { url: 'https://cdn/x.jpg' } }], more: string | null = null) => ({
  id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-10-10T05:00:00Z', cancelledAt: null, note: null, tags: ['x'], email: null, phone: null,
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', currentTotalPriceSet: { shopMoney: { amount: '150.0' } },
  customer: { id: 'gid://shopify/Customer/1', displayName: 'R', defaultEmailAddress: { emailAddress: 'r@x.in' }, defaultPhoneNumber: null },
  shippingAddress: null, billingAddress: null,
  fulfillmentOrders: { nodes: [{ id: `fo${n}`, status: 'ON_HOLD', fulfillmentHolds: [{ reason: 'AWAITING_PAYMENT', reasonNotes: null }, { reason: 'OTHER', reasonNotes: 'wants pink' }] }] },
  lineItems: { pageInfo: { hasNextPage: !!more, endCursor: more }, nodes: lines }, ...changes,
})
const page = (nodes: unknown[], next: string | null = null) => ({ orders: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } })

describe('listOpenOrders', () => {
  it('follows every page, drops cancelled and fulfilled orders, de-duplicates, and reads the extra line pages', async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce(page([raw(1), raw(2, { cancelledAt: '2026-10-10T06:00:00Z' })], 'c1'))
      .mockResolvedValueOnce(page([raw(1), raw(3, { displayFulfillmentStatus: 'FULFILLED' }), raw(4, {}, [{ title: 'A', variantTitle: null, sku: 'A', quantity: 1, unfulfilledQuantity: 1, requiresShipping: true, image: null }], 'l1')]))
      .mockResolvedValueOnce({ order: { lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ title: 'B', variantTitle: 'Red', sku: 'B', quantity: 2, unfulfilledQuantity: 1, requiresShipping: true, image: null }] } } })
    const { orders, truncated } = await listOpenOrders(client(graphql))
    expect(truncated).toBe(false)
    expect(orders.map(o => o.name)).toEqual(['Qimati1', 'Qimati4'])
    expect(orders[1].lines.map(line => line.sku)).toEqual(['A', 'B'])
    expect(graphql.mock.calls[2][1]).toEqual({ id: 'gid://shopify/Order/4', after: 'l1' })
    expect(graphql.mock.calls[0][1].query).toContain('fulfillment_status:on_hold')
    expect(orders[0]).toMatchObject({ total: 150, customer: { id: 'gid://shopify/Customer/1', displayName: 'R', email: 'r@x.in', phone: null }, fulfillmentOrders: [{ id: 'fo1', status: 'ON_HOLD', holdReasons: ['awaiting payment', 'wants pink'] }], lines: [{ imageUrl: 'https://cdn/x.jpg' }] })
    expect(graphql.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true)
  })
  it('says so when the page cap is hit', async () => {
    const graphql = vi.fn().mockResolvedValue(page([raw(1)], 'more'))
    expect((await listOpenOrders(client(graphql))).truncated).toBe(true)
    expect(graphql).toHaveBeenCalledTimes(20)
  })
})
describe('readOrders', () => {
  it('asks in chunks of 25 and skips what Shopify cannot return', async () => {
    const ids = Array.from({ length: 27 }, (_, i) => `gid://shopify/Order/${i + 1}`)
    const graphql = vi.fn().mockResolvedValueOnce({ nodes: [raw(1), null, ...Array(23).fill(null)] }).mockResolvedValueOnce({ nodes: [raw(26), {}] })
    const orders = await readOrders(client(graphql), ids)
    expect(orders.map(o => o.name)).toEqual(['Qimati1', 'Qimati26'])
    expect(graphql.mock.calls[0][1].ids).toHaveLength(25); expect(graphql.mock.calls[1][1].ids).toEqual(ids.slice(25))
  })
})
describe('reportProgress', () => {
  it('sends the fulfilment order id with the note and returns the new status', async () => {
    const graphql = vi.fn().mockResolvedValue({ fulfillmentOrderReportProgress: { fulfillmentOrder: { status: 'IN_PROGRESS' }, userErrors: [] } })
    expect(await reportProgress(client(graphql), 'fo1', 'x'.repeat(300))).toBe('IN_PROGRESS')
    expect(graphql.mock.calls[0][0]).toContain('fulfillmentOrderReportProgress(id: $id, progressReport: $progressReport)')
    expect(graphql.mock.calls[0][1]).toEqual({ id: 'fo1', progressReport: { reasonNotes: 'x'.repeat(256) } })
  })
  it('throws Shopify\'s own words on a user error', async () => {
    const graphql = vi.fn().mockResolvedValue({ fulfillmentOrderReportProgress: { fulfillmentOrder: null, userErrors: [{ message: 'Fulfillment order is on hold.' }] } })
    await expect(reportProgress(client(graphql), 'fo1', 'n')).rejects.toThrow('Fulfillment order is on hold.')
  })
  it('explains a missing scope', () => { expect(slipShopifyError(new Error('Access denied for fulfillmentOrderReportProgress'))).toMatch(/write_merchant_managed_fulfillment_orders/) })
})
