/** Shared shapes of the SKU matcher (D110/D111). */

export type MatchJobKind = 'sync' | 'embed' | 'identify'

export const EMBEDDING_DIM = 1152
export const CANDIDATE_COUNT = 10

export interface Candidate {
  readonly rank: number
  readonly sku: string
  readonly handle: string | null
  readonly score: number
}

/** What /api/worker/claim hands a worker. Everything it needs; nothing it should not have. */
export interface ClaimedJob {
  readonly id: string
  readonly kind: MatchJobKind
  readonly lease_token: string
  readonly lease_expires_at: string
  readonly attempts: number
  readonly reference?: {
    readonly id: string
    readonly sku: string
    readonly handle: string | null
    readonly sha256: string | null
    readonly local_path: string | null
    /** Presigned R2 GET or the public CDN URL. Valid for an hour. */
    readonly source_url: string
    readonly filename: string
  }
  readonly event?: {
    readonly id: string
    readonly surface: string
    /** Presigned R2 GET, or /api/worker/source/{job} for a Drive photograph. */
    readonly source_url: string
  }
}

export interface SyncResult {
  readonly local_path: string
  readonly sha256?: string
  readonly bytes?: number
}

export interface EmbedResult {
  readonly embeddings: { readonly full: readonly number[]; readonly crop: readonly number[] }
  readonly model: string
  readonly crop_box?: readonly number[] | null
}

export interface IdentifyResult {
  readonly embedding: readonly number[]
  readonly model: string
  readonly crop_box?: readonly number[] | null
  readonly fallback_full_frame?: boolean
  readonly timing_ms?: Readonly<Record<string, number>>
}

export interface WorkerFailure {
  readonly message: string
  readonly retryable: boolean
}
