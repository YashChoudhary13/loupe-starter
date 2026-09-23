import { describe, expect, it, vi } from 'vitest'
import { createFulfillment, dispatchShopifyError, listDispatchOrders, readDispatchOrder } from '@/lib/shopify/dispatch-orders'
import type { ShopifyClient } from '@/lib/shopify/client'

const client = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as ShopifyClient
const listed = (n: number, statuses: string[], address: { name: string | null; zip: string | null; address1: string | null } | null = { name: 'R. Sharma', zip: '302001', address1: '12 MI Road' }) =>
  ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-09-21T05:00:00Z', shippingAddress: address, fulfillmentOrders: { nodes: statuses.map((status, i) => ({ id: `gid://shopify/FulfillmentOrder/${n}${i}`, status })) } })
const pageOf = (nodes: unknown[], next: string | null = null) => ({ orders: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } })

describe('listing In-progress orders', () => {
  it('keeps only orders with an IN_PROGRESS fulfilment order and follows every page', async () => {
    const graphql = vi.fn().mockResolvedValueOnce(pageOf([listed(1, ['IN_PROGRESS']), listed(2, ['OPEN'])], 'c1')).mockResolvedValueOnce(pageOf([listed(3, ['CLOSED', 'IN_PROGRESS']), listed(4, ['ON_HOLD'])]))
    const result = await listDispatchOrders(client(graphql))
    expect(result.orders.map(o => o.name)).toEqual(['Qimati1', 'Qimati3'])
    expect(result.truncated).toBe(false)
    expect(graphql.mock.calls[1][1].after).toBe('c1')
    expect(graphql.mock.calls[0][1].query).toContain('status:open')
    expect(graphql.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true)
  })
  it('hashes the destination instead of returning it, and matches the same address', async () => {
    const graphql = vi.fn().mockResolvedValueOnce(pageOf([listed(1, ['IN_PROGRESS']), listed(2, ['IN_PROGRESS'], { name: 'Other', zip: '302001', address1: '12, M.I. Road' }), listed(3, ['IN_PROGRESS'], null)]))
    const { orders } = await listDispatchOrders(client(graphql))
    expect(orders[0].addressKey).toMatch(/^[0-9a-f]{16}$/)
    expect(orders[0].addressKey).toBe(orders[1].addressKey)
    expect(orders[2]).toMatchObject({ customer: '—', addressKey: '' })
    expect(JSON.stringify(orders)).not.toContain('MI Road')
  })
  it('says so when the ten-page cap is hit', async () => {
    const graphql = vi.fn().mockResolvedValue(pageOf([listed(1, ['IN_PROGRESS'])], 'more'))
    expect((await listDispatchOrders(client(graphql))).truncated).toBe(true)
    expect(graphql).toHaveBeenCalledTimes(10)
  })
})

const fo = (changes = {}) => ({ id: 'gid://shopify/FulfillmentOrder/1', status: 'IN_PROGRESS', supportedActions: [{ action: 'CREATE_FULFILLMENT' }], assignedLocation: { location: { id: 'gid://shopify/Location/1' } }, lineItems: { nodes: [{ remainingQuantity: 2 }, { remainingQuantity: 0 }], pageInfo: { hasNextPage: false } }, ...changes })
describe('reading one order for a push', () => {
  it('maps fulfilment orders and fulfilments', async () => {
    const graphql = vi.fn().mockResolvedValue({ order: { id: 'gid://shopify/Order/1', name: 'Qimati1', closed: false, cancelledAt: null, fulfillments: [{ id: 'gid://shopify/Fulfillment/5', status: 'SUCCESS', trackingInfo: [{ company: 'DTDC', number: 'X1' }] }], fulfillmentOrders: { nodes: [fo(), fo({ id: 'gid://shopify/FulfillmentOrder/2', status: 'OPEN', supportedActions: [] })], pageInfo: { hasNextPage: false } } } })
    const order = await readDispatchOrder(client(graphql), '1')
    expect(graphql.mock.calls[0][1]).toEqual({ id: 'gid://shopify/Order/1' })
    expect(order.fulfillmentOrders[0]).toEqual({ id: 'gid://shopify/FulfillmentOrder/1', status: 'IN_PROGRESS', canFulfil: true, remaining: 2, locationId: 'gid://shopify/Location/1', complete: true })
    expect(order.fulfillmentOrders[1].canFulfil).toBe(false)
    expect(order.fulfillments).toEqual([{ id: 'gid://shopify/Fulfillment/5', status: 'SUCCESS', tracking: [{ company: 'DTDC', number: 'X1' }] }])
  })
  it('fails clearly when the order is gone', async () => { await expect(readDispatchOrder(client(vi.fn().mockResolvedValue({ order: null })), '1')).rejects.toThrow(/unavailable/) })
})

describe('the fulfilment mutation', () => {
  it('sends company, number, notifyCustomer and whole fulfilment orders', async () => {
    const graphql = vi.fn().mockResolvedValue({ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/9' }, userErrors: [] } })
    expect(await createFulfillment(client(graphql), { fulfillmentOrderIds: ['gid://shopify/FulfillmentOrder/1'], company: 'DTDC', number: 'X1234567' })).toEqual({ id: 'gid://shopify/Fulfillment/9' })
    expect(graphql.mock.calls[0][1]).toEqual({ fulfillment: { notifyCustomer: true, trackingInfo: { company: 'DTDC', number: 'X1234567' }, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1' }] } })
  })
  it('turns userErrors into one sentence', async () => {
    const graphql = vi.fn().mockResolvedValue({ fulfillmentCreate: { fulfillment: null, userErrors: [{ field: null, message: 'Fulfillment order is not open.' }] } })
    await expect(createFulfillment(client(graphql), { fulfillmentOrderIds: ['x'], company: 'DTDC', number: 'X1234567' })).rejects.toThrow('Fulfillment order is not open.')
  })
  it('names the missing scopes', () => { expect(dispatchShopifyError(new Error('Access denied for fulfillmentOrders field.'))).toMatch(/write_merchant_managed_fulfillment_orders/) })
})
