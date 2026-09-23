import { describe, expect, it } from 'vitest'
import { COUNT_QUERY, countOrders, istDayStart, listOrderIds, listOrders, LOW_STOCK_QUERY, lowStock, ORDER_IDS_QUERY, orderQuery, ORDERS_QUERY, readOnlyShopify, type ReadOnlyShopify } from '@/lib/home/shopify-reads'

const record = () => { const calls: { query: string; variables?: Record<string, unknown> }[] = []; const client = { async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> { calls.push({ query, variables }); return {} as T } }; return { calls, client } }
describe('read-only Shopify', () => {
  it('refuses any document containing a mutation before it is sent', async () => {
    const { calls, client } = record(); const shop = readOnlyShopify(client)
    for (const doc of ['mutation { x }', 'query Q { a } mutation M { b }', ' MUTATION x', 'query { shop { name } } # mutation']) await expect(shop.graphql(doc)).rejects.toThrow(/read-only/)
    expect(calls).toHaveLength(0)
    await shop.graphql('query { shop { name } }'); expect(calls).toHaveLength(1)
  })
  it('every constant query asks for no customer, email, phone or address field', () => {
    for (const query of [ORDERS_QUERY, ORDER_IDS_QUERY, COUNT_QUERY, LOW_STOCK_QUERY]) expect(query).not.toMatch(/customer|email|phone|address|billing/i)
  })
  it('builds the documented search per filter, with today in IST', () => {
    expect(istDayStart(new Date('2026-09-23T20:30:00Z'))).toBe('2026-09-24T00:00:00+05:30'); expect(istDayStart(new Date('2026-09-23T17:00:00Z'))).toBe('2026-09-23T00:00:00+05:30')
    expect(orderQuery('unfulfilled', new Date())).toBe('status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) (financial_status:paid OR financial_status:partially_paid OR financial_status:partially_refunded)')
    expect(orderQuery('awaiting_qc', new Date())).toBe(orderQuery('unfulfilled', new Date()))
    expect(orderQuery('today', new Date('2026-09-23T17:00:00Z'))).toBe("created_at:>='2026-09-23T00:00:00+05:30' -status:cancelled")
    expect(orderQuery('on_hold', new Date())).toBe('status:open fulfillment_status:on_hold')
  })
  it('a raw client is not assignable as read-only (compile-time)', () => {
    // @ts-expect-error a raw client is not read-only
    const notReadOnly: ReadOnlyShopify = { async graphql() { return {} } }
    void notReadOnly
  })
})
describe('readers', () => {
  it('maps orders to the six safe fields', async () => {
    const shop: ReadOnlyShopify = { readOnly: true, async graphql<T>() { return { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: 'Qimati1', createdAt: '2026-09-23T05:00:00Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', subtotalLineItemsQuantity: 3, totalPriceSet: { shopMoney: { amount: '1200.00', currencyCode: 'INR' } } }] } } as T } }
    expect(await listOrders(shop, 'q', 5)).toEqual({ ids: ['gid://shopify/Order/1'], rows: [{ name: 'Qimati1', createdAt: '2026-09-23T05:00:00Z', payment: 'PAID', fulfilment: 'UNFULFILLED', total: '1200.00 INR', items: 3 }] })
  })
  it('pages ids up to the cap and says when it stopped early', async () => {
    let page = 0
    const afters: unknown[] = []
    const shop: ReadOnlyShopify = { readOnly: true, async graphql<T>(_query: string, variables?: Record<string, unknown>) { afters.push(variables?.after); page++; return { orders: { nodes: Array.from({ length: 100 }, (_, n) => ({ id: `gid://shopify/Order/${page * 100 + n}` })), pageInfo: { hasNextPage: true, endCursor: `c${page}` } } } as T } }
    const result = await listOrderIds(shop, 'q', 250)
    expect(result.ids).toHaveLength(250); expect(result.truncated).toBe(true); expect(page).toBe(3)
    expect(afters).toEqual([null, 'c1', 'c2'])
  })
  it('counts through ordersCount and reads low stock with the threshold in the search', async () => {
    const { calls, client } = record()
    client.graphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => { calls.push({ query, variables }); return (query === COUNT_QUERY ? { ordersCount: { count: 7, precision: 'EXACT' } } : { productVariants: { nodes: [{ sku: 'RS004-C-GOLD', title: 'Gold', inventoryQuantity: 1, product: { title: 'Rings 004' } }] } }) as T }
    const shop = readOnlyShopify(client)
    expect(await countOrders(shop, 'status:open')).toBe(7)
    expect(await lowStock(shop, 3, 10)).toEqual([{ sku: 'RS004-C-GOLD', product: 'Rings 004', variant: 'Gold', quantity: 1 }])
    expect(calls[1].variables).toEqual({ query: 'inventory_quantity:<=3 product_status:active', first: 10 })
  })
})
