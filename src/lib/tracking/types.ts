import type { SignedImage } from '@/lib/console/types'

/**
 * Two views only. Drafts live in the Console (their working home) and the old
 * "All" tab answered no question anyone asked. Tracking is for what is wrong
 * (attention) and what is still moving (progress).
 */
export type TrackingView = 'attention' | 'progress'
/**
 * `hidden` classifies work that is healthy and already represented elsewhere —
 * an enhanced photograph sitting in the console's Pending grid, an assembling
 * draft in the console's Drafts view. The read model drops these rows.
 */
export type TrackingGroup = 'attention' | 'draft' | 'progress' | 'complete' | 'hidden'
export type TrackingTone = 'failed' | 'stalled' | 'running' | 'mismatch' | 'complete'

export interface TrackingEvent {
  readonly id: number
  readonly event: string
  readonly createdAt: string
  readonly actor: string | null
  readonly detail: string
}

export interface TrackingDuplicate {
  readonly matchIntakeFileId: string
  readonly matchFilename: string
  readonly distance: number
  readonly canMarkDuplicate: boolean
}

export interface TrackingRow {
  readonly rowId: string
  readonly kind: 'intake' | 'draft' | 'reconciliation'
  readonly entityId: string
  readonly label: string
  readonly statusLabel: string
  readonly tone: TrackingTone
  readonly group: TrackingGroup
  readonly occurredAt: string
  readonly reason: string
  readonly errorCode: string | null
  readonly errorClass: string | null
  readonly rawDetail: string | null
  readonly thumb: SignedImage | null
  readonly events: readonly TrackingEvent[]
  readonly canSkip: boolean
  /** On-hold work only: send it back to the console as it is. */
  readonly canResume: boolean
  /** On-hold work only: remove it from Loupe. */
  readonly canDiscard: boolean
  readonly consoleHref: string | null
  readonly duplicate: TrackingDuplicate | null
  /**
   * Reconciliation findings only: the operator can record that this specific
   * difference is acceptable. Durable across runs, and it comes back if the
   * observed value changes again. See D93.
   */
  readonly canDismiss: boolean
}

export interface ReconciliationSummary {
  readonly id: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly startedAt: string
  readonly completedAt: string | null
  readonly totalProducts: number
  readonly matchedProducts: number
  readonly issueCount: number
  readonly error: string | null
}

export interface TrackingSnapshot {
  readonly uploadedToday: number
  readonly listedToday: number
  readonly attentionCount: number
  readonly inQueueCount: number
  readonly rows: readonly TrackingRow[]
  readonly latestReconciliation: ReconciliationSummary | null
  readonly generatedAt: string
  readonly signedUntil: number
}
