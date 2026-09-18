export interface QcLine {
  id: string
  variantId: string | null
  title: string
  variantTitle: string | null
  sku: string | null
  barcode: string | null
  required: number
  /** Shopify CDN thumbnail of the line's product; display only, never part of the fingerprint. */
  image?: string | null
}

export interface QcOrder {
  id: string
  name: string
  updatedAt: string
  cancelledAt: string | null
  fulfillmentStatus: string
  lines: QcLine[]
  blockedReason: string | null
}

export interface QcSession {
  id: string
  order_id: string
  fingerprint: string
  snapshot: QcOrder
  counts: Record<string, number>
  status: 'checking' | 'passed' | 'stale'
  generation: number
  version: number
  checked_at: string
  completed_at: string | null
  completed_by: string | null
}

export interface QcEvent {
  id: string
  action: string
  outcome: string
  message: string
  code: string | null
  line_id: string | null
  variant_id: string | null
  actor_id: string
  actor_name: string
  created_at: string
  generation: number
  undo_of: string | null
}

export type QcResolution = 'refund' | 'coupon' | 'shipped' | 'other' | 'found' | 'cancelled'
export const QC_STAFF_RESOLUTIONS: readonly QcResolution[] = ['refund', 'coupon', 'shipped', 'other']

/** One line marked short in one checklist; open until resolved. */
export interface QcShortage {
  id: string
  ref: number
  session_id: string
  event_id: string
  order_id: string
  order_name: string
  generation: number
  line_id: string
  variant_id: string | null
  sku: string | null
  title: string
  variant_title: string | null
  quantity: number
  reason: string
  reported_by: string
  reported_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution: QcResolution | null
  resolution_note: string | null
}

export interface QcView {
  order: QcOrder
  session: QcSession
  events: QcEvent[]
  /** Open shortages of the current checklist. */
  shortages: QcShortage[]
  operatorId: string
  event?: QcEvent
  replayed?: boolean
}

/** A passed checklist, read from the append-only audit; survives later fulfillment or order edits. */
export interface QcPass {
  orderId: string
  orderName: string
  passedAt: string
  passedBy: string
  units: number
  short: number
  sessionStatus: QcSession['status']
}

export type QcAction = 'scan' | 'complete' | 'reset' | 'undo' | 'clear_extra' | 'short'
export interface QcCommand {
  action: QcAction
  requestId: string
  code?: string
  expectedGeneration?: number
  expectedVersion?: number
  undoEventId?: string
  extraEventId?: string
  lineId?: string
  reason?: string
}
