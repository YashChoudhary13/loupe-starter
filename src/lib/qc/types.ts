export interface QcLine {
  id: string
  variantId: string | null
  title: string
  variantTitle: string | null
  sku: string | null
  barcode: string | null
  required: number
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

export interface QcView {
  order: QcOrder
  session: QcSession
  events: QcEvent[]
  operatorId: string
  event?: QcEvent
  replayed?: boolean
}

export type QcAction = 'scan' | 'complete' | 'reset' | 'undo' | 'clear_extra'
export interface QcCommand {
  action: QcAction
  requestId: string
  code?: string
  expectedGeneration?: number
  expectedVersion?: number
  undoEventId?: string
  extraEventId?: string
  reason?: string
}
