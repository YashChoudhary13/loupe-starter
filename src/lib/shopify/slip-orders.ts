import type { ShopifyClient } from './client'
import type { SlipAddress, SlipFulfillmentOrder, SlipLine, SlipOrder } from '@/lib/slips/types'

/** Open orders for packing slips (D146). The same read `packing_list.py` makes: every state that still has units to ship,
 * because Shopify's `unfulfilled` search leaves out orders on hold. `unfulfilledQuantity` counts held units and drops
 * refunded ones; `fulfillableQuantity` reads 0 on every held line, so it is never asked for. */
export const OPEN_QUERY = 'status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial OR fulfillment_status:on_hold OR fulfillment_status:scheduled)'
const MAX_PAGES = 20
const LINE = 'title variantTitle sku quantity unfulfilledQuantity requiresShipping image { url(transform: {maxWidth: 96, maxHeight: 96}) }'
const ADDRESS = 'name phone address1 address2 city provinceCode zip country'
// `customer { … }` needs read_customers, which the owner added to the Loupe app on 2026-10-10 (D146).
const ORDER = `id name createdAt cancelledAt note tags email phone displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount } }
  customer { id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  shippingAddress { ${ADDRESS} } billingAddress { ${ADDRESS} }
  fulfillmentOrders(first: 10) { nodes { id status fulfillmentHolds { reason reasonNotes } } }
  lineItems(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${LINE} } }`

interface RawLine { title: string; variantTitle: string | null; sku: string | null; quantity: number; unfulfilledQuantity: number; requiresShipping: boolean; image: { url: string } | null }
interface RawLines { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawLine[] }
interface RawOrder {
  id: string; name: string; createdAt: string; cancelledAt: string | null; note: string | null; tags: string[]; email: string | null; phone: string | null
  displayFinancialStatus: string; displayFulfillmentStatus: string; currentTotalPriceSet: { shopMoney: { amount: string } }
  customer: { id: string; displayName: string | null; defaultEmailAddress: { emailAddress: string | null } | null; defaultPhoneNumber: { phoneNumber: string | null } | null } | null
  shippingAddress: SlipAddress | null; billingAddress: SlipAddress | null
  fulfillmentOrders: { nodes: { id: string; status: string; fulfillmentHolds: { reason: string; reasonNotes: string | null }[] | null }[] }
  lineItems: RawLines
}

const line = (raw: RawLine): SlipLine => ({ title: raw.title, variantTitle: raw.variantTitle, sku: raw.sku, quantity: raw.quantity, unfulfilledQuantity: raw.unfulfilledQuantity, requiresShipping: raw.requiresShipping, imageUrl: raw.image?.url ?? null })
const fulfillmentOrder = (raw: RawOrder['fulfillmentOrders']['nodes'][number]): SlipFulfillmentOrder => ({ id: raw.id, status: raw.status, holdReasons: (raw.fulfillmentHolds ?? []).map(hold => hold.reasonNotes || hold.reason.replace(/_/g, ' ').toLowerCase()) })
function toOrder(raw: RawOrder, lines: RawLine[]): SlipOrder {
  return {
    id: raw.id, name: raw.name, createdAt: raw.createdAt, note: raw.note, tags: raw.tags ?? [], email: raw.email, phone: raw.phone,
    financialStatus: raw.displayFinancialStatus, fulfillmentStatus: raw.displayFulfillmentStatus, total: Number(raw.currentTotalPriceSet?.shopMoney?.amount ?? 0),
    customer: raw.customer ? { id: raw.customer.id, displayName: raw.customer.displayName, email: raw.customer.defaultEmailAddress?.emailAddress ?? null, phone: raw.customer.defaultPhoneNumber?.phoneNumber ?? null } : null,
    shippingAddress: raw.shippingAddress, billingAddress: raw.billingAddress,
    fulfillmentOrders: raw.fulfillmentOrders.nodes.map(fulfillmentOrder), lines: lines.map(line),
  }
}
/** A wholesale order can pass 100 lines. */
async function allLines(client: ShopifyClient, raw: RawOrder): Promise<RawLine[]> {
  const lines = [...raw.lineItems.nodes]
  let page = raw.lineItems.pageInfo
  while (page.hasNextPage && page.endCursor) {
    const data = await client.graphql<{ order: { lineItems: RawLines } | null }>(`query LoupeSlipLines($id: ID!, $after: String) { order(id: $id) { lineItems(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${LINE} } } } }`, { id: raw.id, after: page.endCursor })
    if (!data.order) break
    lines.push(...data.order.lineItems.nodes)
    page = data.order.lineItems.pageInfo
  }
  return lines
}
const stillOpen = (raw: RawOrder) => !raw.cancelledAt && raw.displayFulfillmentStatus !== 'FULFILLED'

/** Every open order that still has units to ship, oldest first. `truncated` means the page cap was hit: the list is incomplete, so nothing may be printed from it. */
export async function listOpenOrders(client: ShopifyClient): Promise<{ orders: SlipOrder[]; truncated: boolean }> {
  const raws = new Map<string, RawOrder>() // a page boundary can hand the same order back twice
  let after: string | null = null, truncated = true
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { orders: { nodes: RawOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await client.graphql(`
      query LoupeSlipOrders($query: String!, $after: String) {
        orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${ORDER} } }
      }`, { query: OPEN_QUERY, after })
    for (const raw of data.orders.nodes) raws.set(raw.id, raw)
    if (!data.orders.pageInfo.hasNextPage) { truncated = false; break }
    if (!data.orders.pageInfo.endCursor) throw new Error('Shopify returned an incomplete order page. Reload and try again.')
    after = data.orders.pageInfo.endCursor
  }
  const orders: SlipOrder[] = []
  for (const raw of raws.values()) if (stillOpen(raw)) orders.push(toOrder(raw, await allLines(client, raw)))
  return { orders, truncated }
}

/** The given orders, fresh, in the given order; one that Shopify cannot return (deleted, too old for the app) is left out. */
export async function readOrders(client: ShopifyClient, ids: readonly string[]): Promise<SlipOrder[]> {
  const orders: SlipOrder[] = []
  for (let start = 0; start < ids.length; start += 25) {
    const data = await client.graphql<{ nodes: (RawOrder | null)[] }>(`query LoupeSlipOrdersById($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER} } } }`, { ids: ids.slice(start, start + 25) })
    for (const raw of data.nodes) if (raw?.id) orders.push(toOrder(raw, await allLines(client, raw)))
  }
  return orders
}

/** Tells Shopify the order is being packed: the fulfilment order goes OPEN → IN_PROGRESS (API 2026-04+, `write_merchant_managed_fulfillment_orders`). */
export async function reportProgress(client: ShopifyClient, fulfillmentOrderId: string, note: string): Promise<string> {
  const data = await client.graphql<{ fulfillmentOrderReportProgress: { fulfillmentOrder: { status: string } | null; userErrors: { message: string }[] } | null }>(`
    mutation LoupeSlipInProgress($id: ID!, $progressReport: FulfillmentOrderReportProgressInput) {
      fulfillmentOrderReportProgress(id: $id, progressReport: $progressReport) { fulfillmentOrder { status } userErrors { field message } }
    }`, { id: fulfillmentOrderId, progressReport: { reasonNotes: note.slice(0, 256) } })
  const result = data.fulfillmentOrderReportProgress
  if (!result) throw new Error('Shopify did not answer the In-progress update.')
  if (result.userErrors.length) throw new Error(result.userErrors.map(error => error.message).join(' '))
  return result.fulfillmentOrder?.status ?? 'UNKNOWN'
}
export function slipShopifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Shopify did not answer.'
  if (/access denied|fulfillment_orders|permission|access scope/i.test(message)) return 'Loupe cannot read orders or mark them In progress. In the Shopify Dev Dashboard check that the Loupe app has read_customers, read_ and write_merchant_managed_fulfillment_orders, then restart Loupe and reload.'
  return message
}
