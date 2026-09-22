import type { ShopifyClient } from '@/lib/shopify/client'
import { PAID } from '@/lib/shopify/qc-orders'

export interface ReadOnlyShopify { graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> }
/** The assistant's only route to Shopify (D137). A document containing a mutation is refused before it is sent, and every query it carries is a constant in this file. */
export function readOnlyShopify(client: Pick<ShopifyClient, 'graphql'>): ReadOnlyShopify {
  return { graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (/\bmutation\b/i.test(query)) return Promise.reject(new Error('The home assistant is read-only: mutations are refused.'))
    return client.graphql<T>(query, variables)
  } }
}

export const OPEN_PAID_QUERY = `status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) ${PAID}`
export const ORDER_FILTERS = ['unfulfilled', 'awaiting_qc', 'awaiting_tracking', 'today', 'on_hold'] as const
export type OrderFilter = (typeof ORDER_FILTERS)[number]
/** Midnight in Asia/Kolkata for the calendar day containing `now`, with the +05:30 offset Shopify's search accepts. */
export function istDayStart(now: Date): string { return `${new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00+05:30` }
export function orderQuery(filter: Exclude<OrderFilter, 'awaiting_tracking'>, now: Date): string {
  if (filter === 'today') return `created_at:>='${istDayStart(now)}' -status:cancelled`
  if (filter === 'on_hold') return 'status:open fulfillment_status:on_hold'
  return OPEN_PAID_QUERY
}

/* No customer, email, phone or address field in any of these — by construction, and asserted by tests/home-shopify-reads.test.ts. */
export const ORDERS_QUERY = `query LoupeHomeOrders($query: String!, $first: Int!) { orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus subtotalLineItemsQuantity totalPriceSet { shopMoney { amount currencyCode } } } } }`
export const ORDER_IDS_QUERY = `query LoupeHomeOrderIds($query: String!, $after: String) { orders(first: 100, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { id } pageInfo { hasNextPage endCursor } } }`
export const COUNT_QUERY = `query LoupeHomeCount($query: String!) { ordersCount(query: $query, limit: 10000) { count precision } }`
export const LOW_STOCK_QUERY = `query LoupeHomeLowStock($query: String!, $first: Int!) { productVariants(first: $first, query: $query, sortKey: INVENTORY_QUANTITY) { nodes { sku title inventoryQuantity product { title } } } }`

export interface OrderRow { name: string; createdAt: string; payment: string; fulfilment: string; total: string; items: number }
interface RawOrder { id: string; name: string; createdAt: string; displayFinancialStatus: string; displayFulfillmentStatus: string; subtotalLineItemsQuantity: number; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } }
export async function listOrders(shop: ReadOnlyShopify, query: string, limit: number): Promise<{ rows: OrderRow[]; ids: string[] }> {
  const data = await shop.graphql<{ orders: { nodes: RawOrder[] } }>(ORDERS_QUERY, { query, first: limit })
  const nodes = data.orders.nodes
  return { ids: nodes.map(order => order.id), rows: nodes.map(order => ({ name: order.name, createdAt: order.createdAt, payment: order.displayFinancialStatus, fulfilment: order.displayFulfillmentStatus, total: `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`, items: order.subtotalLineItemsQuantity })) }
}
export async function listOrderIds(shop: ReadOnlyShopify, query: string, max = 300): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = []
  let after: string | null = null
  while (ids.length < max) {
    const data: { orders: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await shop.graphql(ORDER_IDS_QUERY, { query, after })
    ids.push(...data.orders.nodes.map(node => node.id))
    if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) return { ids: ids.slice(0, max), truncated: ids.length > max }
    after = data.orders.pageInfo.endCursor
  }
  return { ids: ids.slice(0, max), truncated: true }
}
export async function countOrders(shop: ReadOnlyShopify, query: string): Promise<number> {
  const data = await shop.graphql<{ ordersCount: { count: number } | null }>(COUNT_QUERY, { query })
  if (!data.ordersCount) throw new Error('Shopify returned no count.')
  return data.ordersCount.count
}
export interface StockRow { sku: string | null; product: string; variant: string; quantity: number }
export async function lowStock(shop: ReadOnlyShopify, threshold: number, limit: number): Promise<StockRow[]> {
  const data = await shop.graphql<{ productVariants: { nodes: { sku: string | null; title: string; inventoryQuantity: number; product: { title: string } }[] } }>(LOW_STOCK_QUERY, { query: `inventory_quantity:<=${threshold} product_status:active`, first: limit })
  return data.productVariants.nodes.map(node => ({ sku: node.sku, product: node.product.title, variant: node.title, quantity: node.inventoryQuantity }))
}
