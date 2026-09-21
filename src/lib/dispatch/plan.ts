import type { Carrier, DispatchOrderSnapshot, PushPlan } from './types'

const refuse = (reason: string): PushPlan => ({ kind: 'refuse', reason })

/** What one order needs, decided from a fresh Shopify read. Pure: no I/O, no clock. */
export function planPush(order: DispatchOrderSnapshot, carrier: Carrier, number: string): PushPlan {
  if (order.cancelledAt) return refuse(`${order.name} is cancelled. Do not ship it.`)
  if (order.closed) return refuse(`${order.name} is archived in Shopify.`)
  if (!order.fulfillmentOrdersComplete || order.fulfillmentOrders.some(item => !item.complete)) return refuse(`${order.name} is too large to fulfil from Loupe. Fulfil it in Shopify.`)
  const eligible = order.fulfillmentOrders.filter(item => item.status === 'IN_PROGRESS' && item.canFulfil && item.remaining > 0)
  if (eligible.length === 0) {
    const active = order.fulfillments.filter(item => item.status !== 'CANCELLED')
    const same = active.find(item => item.tracking.some(info => info.company === carrier && info.number === number))
    if (same) return { kind: 'done', fulfillmentId: same.id }
    const other = active.flatMap(item => item.tracking).find(info => info.number)
    if (other) return refuse(`${order.name} is already fulfilled with ${other.company ?? 'another carrier'} ${other.number}.`)
    if (order.fulfillmentOrders.some(item => item.status === 'ON_HOLD')) return refuse(`${order.name} is on hold in Shopify.`)
    return refuse(`${order.name} has nothing In progress to fulfil. Mark it In progress in Shopify.`)
  }
  if (new Set(eligible.map(item => item.locationId)).size > 1) return refuse(`${order.name} has In-progress items at two locations. Fulfil it in Shopify.`)
  return { kind: 'fulfil', fulfillmentOrderIds: eligible.map(item => item.id) }
}

/** After a push: the id of a SUCCESS fulfilment carrying exactly the sent company and number, else null. */
export function confirmsPush(order: DispatchOrderSnapshot, carrier: Carrier, number: string): string | null {
  return order.fulfillments.find(item => item.status === 'SUCCESS' && item.tracking.length === 1 && item.tracking[0].company === carrier && item.tracking[0].number === number)?.id ?? null
}
