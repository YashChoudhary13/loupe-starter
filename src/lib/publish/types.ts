/** Shapes read out of Postgres and handed to the publisher. */

export interface DraftRow {
  readonly id: string
  readonly category_id: string
  readonly material_id: string | null
  readonly title_suffix: string | null
  readonly price_paise: number | null
  readonly weight_g: number | null
  readonly stock: number
  readonly status: 'assembling' | 'publishing' | 'published' | 'failed'
  readonly reserved_sku: string | null
  readonly reserved_handle: string | null
  readonly shopify_product_id: string | null
}

export interface CategoryRow {
  readonly id: string
  readonly name: string
  readonly sku_prefix: string
  readonly title_pattern: string
  /** NULL means "not confirmed against the live store". Publish refuses it. */
  readonly shopify_tag: string | null
  readonly default_weight_g: number | null
  readonly default_stock: number
}

/** One image on the product, in the operator's chosen order. */
export interface PublishImage {
  readonly imageVersionId: string
  readonly intakeFileId: string
  readonly position: number
  /** R2 object key. Presigned at publish time; never stored anywhere public. */
  readonly storageKey: string
  /**
   * The cached factual description of the SOURCE photograph, which becomes this
   * image's Shopify alt text. Cached on `intake_files` by the enhancement
   * pipeline (D36) — the console never generates one, and never makes a model
   * call to fill a null.
   */
  readonly description: string | null
  /** Set once this image has been published; makes a retry reuse the file. */
  readonly shopifyMediaId: string | null
  readonly filename: string
}

/** A draft, its category, its material, its colour variants and its images. */
export interface PublishInput {
  readonly draft: DraftRow
  readonly category: CategoryRow
  readonly materialName: string | null
  /** Colour names in display order. Empty means a single default variant. */
  readonly colours: readonly string[]
  /** Ordered. Empty means the draft has no images selected. */
  readonly images: readonly PublishImage[]
}

export interface PublishedImage {
  readonly imageVersionId: string
  readonly shopifyMediaId: string | null
  readonly alt: string
  readonly altTruncated: boolean
  /** True when there was no cached description and the title was used instead. */
  readonly altFallback: boolean
  readonly reused: boolean
}

/** The identity `public.reserve_draft_identity()` allocated (or reused). */
export interface ReservedIdentity {
  readonly draftId: string
  readonly sku: string
  readonly skuNumber: number
  readonly handle: string
  readonly title: string
  readonly shopifyTag: string
  /** True when a previous attempt had already reserved this — the retry path. */
  readonly reused: boolean
}

export interface PublishResult {
  readonly draftId: string
  readonly shopifyProductId: string
  readonly sku: string
  readonly handle: string
  readonly title: string
  readonly shopifyTag: string
  readonly productType: string
  readonly priceRupees: string
  readonly weightG: number
  readonly stock: number
  readonly material: string | null
  readonly colours: readonly string[]
  /** True when this call updated an existing product rather than creating one. */
  readonly reusedIdentity: boolean
  /** In published order. Empty when the caller published no images. */
  readonly images: readonly PublishedImage[]
}

export interface PublishOptions {
  /**
   * Hard rule 8: zero stock blocks publish "unless explicitly ticked". This is
   * that tick. It is deliberately not a default — an operator has to mean it.
   */
  readonly allowZeroStock?: boolean
  /** Written to `events.actor`, so the audit trail names who did it. */
  readonly actor?: string
  /** Extra Shopify tags alongside the category's. Used to mark test products. */
  readonly extraTags?: readonly string[]
  /**
   * Defaults to TRUE — a Qimati product exists because somebody photographed it,
   * so publishing one with no image is a mistake by default.
   *
   * `npm run verify:publish` sets it false on purpose: that harness proves the
   * SKU/handle/idempotency properties with bare drafts and has no photographs to
   * attach. It is opt-OUT rather than opt-in so a future caller that forgets to
   * think about images fails closed.
   */
  readonly requireImages?: boolean
  /**
   * Turns an R2 object key into a URL Shopify can fetch once. Required whenever
   * images are being uploaded; kept as a callback so the publisher never learns
   * about buckets, credentials or expiry policy.
   */
  readonly signImageUrl?: (storageKey: string) => Promise<string>
}
