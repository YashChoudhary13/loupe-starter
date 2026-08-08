import type { SignedImage } from '@/lib/console/types'

export type TrackingView = 'attention' | 'draft' | 'progress' | 'all'
/**
 * `draft` is its own group, not a flavour of `progress`. Qimati's operators
 * build 100-150 drafts and only then publish the batch, so drafts are the
 * working set — burying them among transient pipeline work made the one list
 * they live in hardest to read.
 */
export type TrackingGroup = 'attention' | 'draft' | 'progress' | 'complete'
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
  /** On-hold work only: send it back to the enhancement queue. */
  readonly canResume: boolean
  /** Provider-credit pause only: release the hold and retry immediately. */
  readonly canResumeEnhancement: boolean
  /** On-hold work only: remove it from Loupe and move it out of RAW. */
  readonly canDiscard: boolean
  readonly consoleHref: string | null
  readonly driveHref: string | null
  readonly duplicate: TrackingDuplicate | null
  /**
   * Reconciliation findings only: the operator can record that this specific
   * difference is acceptable. Durable across runs, and it comes back if the
   * observed value changes again. See D93.
   */
  readonly canDismiss: boolean
  /**
   * What this row has actually cost so far, in USD — provider-reported figures
   * only, never derived from a price table (D5/D35).
   *
   * For a photograph: its cached description plus EVERY generated image, redos
   * included. For a product draft: the same total summed across every
   * photograph grouped into it, which is what the product cost to make.
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
