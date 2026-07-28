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

/** A draft, its category, its material and its colour variants, ready to validate. */
export interface PublishInput {
  readonly draft: DraftRow
  readonly category: CategoryRow
  readonly materialName: string | null
  /** Colour names in display order. Empty means a single default variant. */
  readonly colours: readonly string[]
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
}
