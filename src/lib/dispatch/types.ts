export const CARRIERS = ['DTDC', 'India Post', 'Tirupati Courier'] as const
export type Carrier = (typeof CARRIERS)[number]
export type ParcelOrderStatus = 'staged' | 'pushing' | 'fulfilled' | 'failed'

/** One listed Shopify order. `addressKey` is a hash that only answers "same destination?"; it is never shown. */
export interface DispatchOrderSummary { id: string; name: string; createdAt: string; customer: string; addressKey: string }

export interface DispatchFulfillmentOrder {
  id: string; status: string; canFulfil: boolean; remaining: number; locationId: string | null
  /** False when Shopify returned more than one page of lines, so `remaining` cannot be trusted. */
  complete: boolean
}
export interface DispatchOrderSnapshot {
  id: string; name: string; closed: boolean; cancelledAt: string | null
  fulfillmentOrders: DispatchFulfillmentOrder[]
  fulfillmentOrdersComplete: boolean
  fulfillments: { id: string; status: string; tracking: { company: string | null; number: string | null }[] }[]
}
export type PushPlan =
  | { kind: 'fulfil'; fulfillmentOrderIds: string[] }
  | { kind: 'done'; fulfillmentId: string }
  | { kind: 'refuse'; reason: string }

export interface ParcelOrderRow { id: string; parcel_id: string; order_id: string; order_name: string; position: number; status: ParcelOrderStatus; fulfillment_id: string | null; error: string | null; push_started_at: string | null; finished_at: string | null }
export interface ParcelRow { id: string; tracking_number: string | null; carrier: Carrier | null; carrier_source: 'auto' | 'manual'; staged_by: string; staged_at: string; pushed_by: string | null; pushed_at: string | null; orders: ParcelOrderRow[] }
