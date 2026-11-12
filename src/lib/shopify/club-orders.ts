import type { ShopifyClient } from './client'
import type { SlipAddress, SlipOrder } from '@/lib/slips/types'
import { OPEN_QUERY } from './slip-orders'

/**
 * Who-is-who of every open order, for clubbing in Order QC (D168): the identity fields the packing-list rules
 * (`slips/plan.ts` `customers`) read, and nothing else. No lines and no fulfilment orders, so one request covers
 * 250 orders; `listOpenOrders` (Print slips) pages 50 at a time because it carries every line.
 */
const ADDRESS = 'name phone address1 address2 city provinceCode zip country'
interface Raw {
  id: string; name: string; createdAt: string; cancelledAt: string | null; note: string | null; tags: string[]; email: string | null; phone: string | null
  displayFinancialStatus: string; displayFulfillmentStatus: string
  customer: { id: string; displayName: string | null; defaultEmailAddress: { emailAddress: string | null } | null; defaultPhoneNumber: { phoneNumber: string | null } | null } | null
  shippingAddress: SlipAddress | null; billingAddress: SlipAddress | null
}

export async function listClubOrders(client: ShopifyClient): Promise<SlipOrder[]> {
  const orders: SlipOrder[] = []
  let after: string | null = null
  for (let page = 0; page < 8; page++) {
    const data: { orders: { nodes: Raw[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await client.graphql(`
      query LoupeClubOrders($query: String!, $after: String) {
        orders(first: 250, after: $after, query: $query, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { id name createdAt cancelledAt note tags email phone displayFinancialStatus displayFulfillmentStatus
            customer { id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
            shippingAddress { ${ADDRESS} } billingAddress { ${ADDRESS} } }
        }
      }`, { query: OPEN_QUERY, after })
    for (const raw of data.orders.nodes) {
      if (raw.cancelledAt || raw.displayFulfillmentStatus === 'FULFILLED') continue
      orders.push({
        id: raw.id, name: raw.name, createdAt: raw.createdAt, note: raw.note, tags: raw.tags ?? [], email: raw.email, phone: raw.phone,
        financialStatus: raw.displayFinancialStatus, fulfillmentStatus: raw.displayFulfillmentStatus, total: 0,
        customer: raw.customer ? { id: raw.customer.id, displayName: raw.customer.displayName, email: raw.customer.defaultEmailAddress?.emailAddress ?? null, phone: raw.customer.defaultPhoneNumber?.phoneNumber ?? null } : null,
        shippingAddress: raw.shippingAddress, billingAddress: raw.billingAddress, fulfillmentOrders: [], lines: [],
      })
    }
    if (!data.orders.pageInfo.hasNextPage) return orders
    if (!data.orders.pageInfo.endCursor) break
    after = data.orders.pageInfo.endCursor
  }
  throw new Error('Shopify did not return every open order, so clubs cannot be worked out. Reload and try again.')
}
