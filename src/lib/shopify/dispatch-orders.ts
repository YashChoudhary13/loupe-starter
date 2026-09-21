import { createHash } from 'node:crypto'
import type { ShopifyClient } from './client'
import { PAID } from './qc-orders'
import { orderGid } from '@/lib/qc/validation'
import type { Carrier, DispatchOrderSnapshot, DispatchOrderSummary } from '@/lib/dispatch/types'

const MAX_PAGES = 10
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface RawAddress { name: string | null; zip: string | null; address1: string | null }
interface RawListed { id: string; name: string; createdAt: string; shippingAddress: RawAddress | null; fulfillmentOrders: { nodes: { id: string; status: string }[] } }
interface RawFulfillmentOrder { id: string; status: string; supportedActions: { action: string }[]; assignedLocation: { location: { id: string } | null } | null; lineItems: { nodes: { remainingQuantity: number }[]; pageInfo: { hasNextPage: boolean } } }
interface RawOrder { id: string; name: string; closed: boolean; cancelledAt: string | null; fulfillments: { id: string; status: string; trackingInfo: { company: string | null; number: string | null }[] }[]; fulfillmentOrders: { nodes: RawFulfillmentOrder[]; pageInfo: { hasNextPage: boolean } } }

export function dispatchShopifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Shopify did not answer.'
  if (/access denied|fulfillment_orders|permission|access scope/i.test(message)) return 'Loupe cannot read or fulfil orders yet. In the Shopify Dev Dashboard add read_merchant_managed_fulfillment_orders and write_merchant_managed_fulfillment_orders to the Loupe app, re-approve it, then reload Dispatch.'
  return message
}

/** Same destination → same key. A hash, so no address leaves the server. */
function addressKey(address: RawAddress | null): string {
  if (!address) return ''
  const plain = [address.zip, address.address1].map(part => (part ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')).join('|')
  return createHash('sha256').update(plain).digest('hex').slice(0, 16)
}

/**
 * Open, paid orders with a fulfilment order In progress. Shopify rejects `fulfillment_status:in_progress`
 * as a search term (verified 2026-09-11), so the filter runs on the returned fulfilment orders.
 */
export async function listDispatchOrders(client: ShopifyClient): Promise<{ orders: DispatchOrderSummary[]; truncated: boolean }> {
  const query = `status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) ${PAID}`
  const orders: DispatchOrderSummary[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { orders: { nodes: RawListed[]; pageInfo: PageInfo } } = await client.graphql(`
      query LoupeDispatchOrders($query: String!, $after: String) {
        orders(first: 30, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes { id name createdAt shippingAddress { name zip address1 } fulfillmentOrders(first: 10) { nodes { id status } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { query, after })
    for (const order of data.orders.nodes) {
      if (!order.fulfillmentOrders.nodes.some(item => item.status === 'IN_PROGRESS')) continue
      orders.push({ id: order.id, name: order.name, createdAt: order.createdAt, customer: order.shippingAddress?.name?.trim() || '—', addressKey: addressKey(order.shippingAddress) })
    }
    if (!data.orders.pageInfo.hasNextPage) return { orders, truncated: false }
    if (!data.orders.pageInfo.endCursor) throw new Error('Shopify returned an incomplete order page. Reload Dispatch.')
    after = data.orders.pageInfo.endCursor
  }
  return { orders, truncated: true }
}

export async function readDispatchOrder(client: ShopifyClient, id: string): Promise<DispatchOrderSnapshot> {
  const data = await client.graphql<{ order: RawOrder | null }>(`
    query LoupeDispatchOrder($id: ID!) {
      order(id: $id) {
        id name closed cancelledAt
        fulfillments(first: 50) { id status trackingInfo { company number } }
        fulfillmentOrders(first: 10) {
          nodes { id status supportedActions { action } assignedLocation { location { id } } lineItems(first: 100) { nodes { remainingQuantity } pageInfo { hasNextPage } } }
          pageInfo { hasNextPage }
        }
      }
    }`, { id: orderGid(id) })
  const order = data.order
  if (!order) throw new Error('This order is unavailable. It may have been deleted, or the app cannot read orders this old.')
  return {
    id: order.id, name: order.name, closed: order.closed, cancelledAt: order.cancelledAt,
    fulfillmentOrdersComplete: !order.fulfillmentOrders.pageInfo.hasNextPage,
    fulfillmentOrders: order.fulfillmentOrders.nodes.map(item => ({
      id: item.id, status: item.status, canFulfil: item.supportedActions.some(action => action.action === 'CREATE_FULFILLMENT'),
      remaining: item.lineItems.nodes.reduce((sum, line) => sum + Math.max(0, line.remainingQuantity), 0),
      locationId: item.assignedLocation?.location?.id ?? null, complete: !item.lineItems.pageInfo.hasNextPage,
    })),
    fulfillments: order.fulfillments.map(item => ({ id: item.id, status: item.status, tracking: item.trackingInfo.map(info => ({ company: info.company, number: info.number })) })),
  }
}

/** Fulfils every remaining item of the given fulfilment orders. Call only with a single-attempt client. */
export async function createFulfillment(client: ShopifyClient, input: { fulfillmentOrderIds: readonly string[]; company: Carrier; number: string }): Promise<{ id: string }> {
  const data = await client.graphql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] } }>(`
    mutation LoupeDispatchFulfil($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } }
    }`, { fulfillment: { notifyCustomer: true, trackingInfo: { company: input.company, number: input.number }, lineItemsByFulfillmentOrder: input.fulfillmentOrderIds.map(id => ({ fulfillmentOrderId: id })) } })
  if (data.fulfillmentCreate.userErrors.length) throw new Error(data.fulfillmentCreate.userErrors.map(error => error.message).join(' '))
  if (!data.fulfillmentCreate.fulfillment) throw new Error('Shopify returned no fulfilment.')
  return { id: data.fulfillmentCreate.fulfillment.id }
}
