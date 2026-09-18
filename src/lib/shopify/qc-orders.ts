import type { ShopifyClient } from './client'
import type { QcLine, QcOrder } from '@/lib/qc/types'
import { orderGid } from '@/lib/qc/validation'

export interface QcOrderSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  displayFulfillmentStatus: string
  displayFinancialStatus: string
}
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface RawLine {
  id: string; title: string; variantTitle: string | null; sku: string | null
  requiresShipping: boolean; fulfillableQuantity: number
  image: { url: string } | null
  variant: { id: string; sku: string | null; barcode: string | null; title: string } | null
}
interface RawOrder {
  id: string; name: string; updatedAt: string; cancelledAt: string | null; displayFulfillmentStatus: string
  lineItems: { nodes: RawLine[]; pageInfo: PageInfo }
}
const headerFields = 'id name updatedAt cancelledAt displayFulfillmentStatus'
/** Qimati is prepaid only: an unpaid order is not ready to pack, so it stays off the QC list. */
const PAID = '(financial_status:paid OR financial_status:partially_paid OR financial_status:partially_refunded)'

export function qcShopifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Shopify did not answer.'
  if (/access denied|read_orders|permission|access scope/i.test(message)) return 'Loupe cannot read Shopify orders yet. Ask the store owner to enable read_orders for the Loupe Shopify app, then reopen QC. Older orders also need read_all_orders.'
  return message
}

export async function listQcOrders(client: ShopifyClient, search = '', after: string | null = null) {
  const term = search.trim()
  if (term.length > 60 || (term && !/^[#\w -]+$/.test(term))) throw new Error('Search by order number, for example Qimati5019.')
  if (after && (after.length > 1500 || !/^[a-zA-Z0-9+/=_-]+$/.test(after))) throw new Error('Invalid order page. Return to the first page.')
  // A searched order number is shown whatever its payment state, so a specific order can always be opened.
  const query = `status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial)${term ? ` name:${JSON.stringify(term.replace(/^#/, ''))}` : ` ${PAID}`}`
  const data = await client.graphql<{ orders: { nodes: QcOrderSummary[]; pageInfo: PageInfo } }>(`
    query LoupeQcOrders($query: String!, $after: String) {
      orders(first: 30, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes { id name createdAt updatedAt displayFulfillmentStatus displayFinancialStatus }
        pageInfo { hasNextPage endCursor }
      }
    }`, { query, after })
  if (data.orders.pageInfo.hasNextPage && !data.orders.pageInfo.endCursor) throw new Error('Shopify returned an incomplete order page. Refresh before continuing.')
  return data.orders
}

/** Paginate every order line, then verify the order did not change while paging. */
export async function readQcOrder(client: ShopifyClient, id: string): Promise<QcOrder> {
  const gid = orderGid(id)
  for (let attempt = 0; attempt < 3; attempt++) {
    let after: string | null = null
    let first: RawOrder | null = null
    const lines: QcLine[] = []
    const seen = new Set<string>()
    let changed = false
    for (let page = 0; page < 100; page++) {
      const data: { order: RawOrder | null } = await client.graphql(`
        query LoupeQcOrder($id: ID!, $after: String) {
          order(id: $id) {
            ${headerFields}
            lineItems(first: 100, after: $after) {
              nodes { id title variantTitle sku requiresShipping fulfillableQuantity image { url(transform: { maxWidth: 320, maxHeight: 320 }) } variant { id sku barcode title } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`, { id: gid, after })
      const order = data.order
      if (!order) throw new Error('This order is unavailable. It may have been deleted, or the app cannot read orders this old.')
      first ??= order
      if (first.updatedAt !== order.updatedAt || first.cancelledAt !== order.cancelledAt) { changed = true; break }
      for (const line of order.lineItems.nodes) {
        if (seen.has(line.id)) throw new Error('Shopify repeated an order line. Refresh before scanning.')
        seen.add(line.id)
        if (!Number.isSafeInteger(line.fulfillableQuantity) || line.fulfillableQuantity < 0) throw new Error('Shopify returned an invalid remaining quantity. Review the order in Shopify.')
        if (!line.requiresShipping || line.fulfillableQuantity === 0) continue
        lines.push({ id: line.id, variantId: line.variant?.id ?? null, title: line.title,
          variantTitle: line.variant?.title === 'Default Title' ? null : (line.variant?.title ?? line.variantTitle),
          sku: line.variant?.sku ?? line.sku, barcode: line.variant?.barcode ?? null, required: line.fulfillableQuantity,
          image: /^https:\/\/cdn\.shopify\.com\//.test(line.image?.url ?? '') ? line.image!.url : null })
      }
      if (!order.lineItems.pageInfo.hasNextPage) {
        const final = await client.graphql<{ order: Omit<RawOrder, 'lineItems'> | null }>(`
          query LoupeQcOrderVersion($id: ID!) { order(id: $id) { ${headerFields} } }`, { id: gid })
        if (!final.order || first.updatedAt !== final.order.updatedAt || first.cancelledAt !== final.order.cancelledAt) { changed = true; break }
        const blockedReason = first.cancelledAt ? 'This order is cancelled. Do not pack it.'
          : ['ON_HOLD', 'SCHEDULED'].includes(first.displayFulfillmentStatus) ? 'This order is on hold or scheduled. Resolve its fulfillment status in Shopify before QC.'
          : lines.length === 0 ? 'There are no remaining shipping units to check.'
          : lines.some(line => !line.variantId) ? 'This order includes a custom or deleted variant. Resolve that line in Shopify before barcode QC.'
          : null
        return { id: gid, name: first.name, updatedAt: first.updatedAt, cancelledAt: first.cancelledAt,
          fulfillmentStatus: first.displayFulfillmentStatus, lines, blockedReason }
      }
      const next = order.lineItems.pageInfo.endCursor
      if (!next || after === next) throw new Error('Shopify could not load every order line. No QC changes were saved.')
      after = next
    }
    if (!changed) throw new Error('This order has too many lines for QC. No partial order was accepted.')
  }
  throw new Error('This order is changing in Shopify. Wait for those edits to finish, then reopen QC.')
}
