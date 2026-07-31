/**
 * Everything the browser is allowed to know.
 *
 * These are the ONLY shapes that cross from the server into the console. There
 * is no storage key, no bucket name, no draft-internal id the operator cannot
 * already see, and no permanent URL — image access is a presigned URL with an
 * expiry stamped on it, so a snapshot that leaks is a snapshot that stops
 * working.
 */

export interface SignedImage {
  /** Short-lived presigned R2 GET. Never persisted, never public. */
  readonly url: string
  /** Epoch milliseconds. The console refreshes itself before this passes. */
  readonly expiresAt: number
}

export interface VersionSummary {
  readonly id: string
  readonly kind: 'original' | 'generated'
  readonly versionNo: number
  /** The version the enhancement pipeline marked as the one to publish. */
  readonly isSelected: boolean
  readonly model: string | null
  readonly width: number | null
  readonly height: number | null
  readonly createdAt: string
  readonly thumb: SignedImage | null
  readonly full: SignedImage | null
}

export interface RedoSummary {
  readonly jobId: string
  readonly status: 'queued' | 'processing' | 'completed' | 'failed'
  readonly versionNo: number
  readonly error: string | null
  readonly createdAt: string
}

export interface PhotoSummary {
  readonly intakeFileId: string
  readonly filename: string
  readonly status: string
  readonly discoveredAt: string
  /** Cached factual description. Becomes the Shopify image alt text. */
  readonly description: string | null
  readonly descriptionMissing: boolean
  readonly presentationClass: string | null
  /** Warning only. Publishing remains available until an operator decides. */
  readonly possibleDuplicate: {
    readonly matchIntakeFileId: string
    readonly matchFilename: string
    readonly distance: number
  } | null
  readonly versions: readonly VersionSummary[]
  /** Latest image-only redo request, if one exists. */
  readonly redo: RedoSummary | null
}

export type QueueTileKind = 'photo' | 'draft'

export interface QueueTile {
  readonly kind: QueueTileKind
  /** Intake file id for a photo, draft id for a draft. */
  readonly id: string
  readonly label: string
  readonly thumb: SignedImage | null
  /** Photographs in this product. 1 for an ungrouped photo. */
  readonly imageCount: number
  readonly categoryName: string | null
  readonly status: string
  /** Amber, and only amber. Null means nothing needs a human. */
  readonly attention: string | null
  readonly reservedSku: string | null
}

export interface CategoryOption {
  readonly id: string
  readonly name: string
  readonly skuPrefix: string
  readonly titlePattern: string
  /** NULL means unconfirmed — publishing is blocked and the chip says so (D23). */
  readonly shopifyTag: string | null
  readonly defaultWeightG: number | null
  readonly defaultStock: number
  /** `sku_counters.last_number`; the preview shows this + 1. */
  readonly lastNumber: number
}

export interface MaterialOption {
  readonly id: string
  readonly name: string
}

export interface DraftImageRef {
  readonly imageVersionId: string
  readonly intakeFileId: string
  readonly position: number
  readonly shopifyMediaId: string | null
}

export interface DraftDetail {
  readonly id: string
  readonly status: 'assembling' | 'publishing' | 'published' | 'failed'
  /** Optimistic-concurrency token. Sent back on save; a mismatch refuses. */
  readonly updatedAt: string
  readonly categoryId: string
  readonly materialId: string | null
  /** One-off material for this product. Mutually exclusive with materialId. */
  readonly customMaterial: string | null
  /** Plain-text replacement for the standard six-bullet description. */
  readonly descriptionOverride: string | null
  readonly titleSuffix: string | null
  readonly pricePaise: number | null
  readonly weightG: number | null
  readonly stock: number
  readonly reservedSku: string | null
  readonly reservedHandle: string | null
  readonly shopifyProductId: string | null
  readonly error: string | null
  readonly publishInFlight: boolean
  readonly colours: readonly string[]
  readonly photos: readonly PhotoSummary[]
  readonly images: readonly DraftImageRef[]
}

export interface ColourSuggestion {
  readonly name: string
  readonly usageCount: number
}

/**
 * Drive files the pipeline has not yet finished with — no tile exists for these
 * yet, so the grid alone cannot show them. `uploading` is Loupe's own word for
 * `discovered`: the file has landed in Drive and Loupe has noticed it, before the
 * two-call enhancement starts.
 */
export interface PipelineActivity {
  readonly uploading: number
  readonly processing: number
}

export interface QueueSnapshot {
  /** Work still waiting for an operator: ungrouped photographs and open drafts. */
  readonly tiles: readonly QueueTile[]
  /** Published drafts whose published_at falls in today's Asia/Kolkata day. */
  readonly listedTodayTiles: readonly QueueTile[]
  readonly ungroupedCount: number
  readonly draftCount: number
  readonly publishedToday: number
  readonly attentionCount: number
  readonly pipelineActivity: PipelineActivity
  /** Epoch ms at which the earliest presigned URL in this snapshot dies. */
  readonly signedUntil: number
  readonly generatedAt: string
}

export interface ConsoleCatalog {
  readonly categories: readonly CategoryOption[]
  readonly materials: readonly MaterialOption[]
}
