/** Shapes read out of Postgres and handed to the publisher. */
import type { SalesChannel } from '@/lib/shopify/publications'

export interface DraftRow {
  readonly id: string
  readonly category_id: string
  readonly material_id: string | null
  readonly custom_material: string | null
  readonly description_override: string | null
  readonly title_suffix: string | null
  readonly price_paise: number | null
  readonly weight_g: number | null
  readonly stock: number
  readonly variant_kind: 'none' | 'colour' | 'number' | 'size'
  readonly status: 'assembling' | 'publishing' | 'published' | 'failed'
  readonly reserved_sku: string | null
  readonly reserved_handle: string | null
  readonly shopify_product_id: string | null
  /** A product Loupe created for this draft cannot be older than this. */
  readonly created_at: string
}

export interface CategoryRow {
  readonly id: string
  readonly name: string
  readonly sku_prefix: string
  readonly title_pattern: string
  /** NULL means "not confirmed against the live store". Publish refuses it. */
  readonly shopify_tag: string | null
  /** Shopify Standard Product Taxonomy GID used by native category attributes. */
  readonly shopify_taxonomy_category_id: string | null
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
  /** Customer-facing colour option this image represents; null is a general image. */
  readonly colourValue: string | null
  readonly filename: string
}

export interface PublishVariant {
  readonly value: string
  readonly stock: number
}

/** A draft, its category, its option variants and its images. */
export interface PublishInput {
  readonly draft: DraftRow
  readonly category: CategoryRow
  readonly materialName: string | null
  /** Customer choices in display order. Empty means a single default variant. */
  readonly variants: readonly PublishVariant[]
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
  readonly descriptionHtml: string
  readonly variantKind: DraftRow['variant_kind']
  readonly variants: readonly PublishVariant[]
  /** True when this call updated an existing product rather than creating one. */
  readonly reusedIdentity: boolean
  /** In published order. Empty when the caller published no images. */
  readonly images: readonly PublishedImage[]
  /**
   * The sales channels this product was published to. Empty only when the store
   * has no active sales channel at all — `productSet` cannot set publications,
   * so every publish makes a second call and this records what it achieved.
   */
  readonly salesChannels: readonly SalesChannel[]
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
  /**
   * D60 (supersedes D7). `'DRAFT'` is Save Draft pushing an unfinished product
   * to Shopify: the product is created with status DRAFT, the price guard is
   * relaxed, and the Loupe draft is NOT marked published — it is still the
   * operator's to finish.
   *
   * Defaults to `'ACTIVE'`, which is the live publish path and behaves exactly
   * as it always has. A caller that forgets this field publishes live, which is
   * the safe direction to fail for a field whose other value means "invisible
   * to buyers".
   */
  readonly shopifyStatus?: 'ACTIVE' | 'DRAFT'
}
