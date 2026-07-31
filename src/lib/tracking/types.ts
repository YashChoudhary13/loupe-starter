import type { SignedImage } from '@/lib/console/types'

export type TrackingView = 'attention' | 'progress' | 'all'
export type TrackingGroup = 'attention' | 'progress' | 'complete'
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
  readonly canRetry: boolean
  readonly canSkip: boolean
  readonly consoleHref: string | null
  readonly driveHref: string | null
  readonly duplicate: TrackingDuplicate | null
  /**
   * What this photograph has actually cost so far, in USD: the cached
   * description plus EVERY generated image, redos included — provider-reported
   * figures only, never derived from a price table (D5/D35).
   *
   * Null means nothing has been billed yet. That is different from 0, which
   * would claim a paid call returned free.
   */
  readonly costUsd: number | null
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
