/**
 * publishProduct() — the Shopify write path.
 *
 * The sequence, and why it is this order (CLAUDE.md hard rules 1, 2 and 8):
 *
 *   1. Load the draft, its category, its material and its colours.
 *   2. Validate. Report EVERY reason it cannot go out, at once, before touching
 *      anything. A blocked publish must burn no SKU number.
 *   3. Reserve the SKU and the handle and move the draft to `publishing`, in ONE
 *      database transaction (`public.reserve_draft_identity`). If the draft
 *      already carries a reservation, that call reuses it and allocates nothing.
 *   4. `productSet`, identified BY HANDLE, so a retry updates the same product.
 *   5. Mark published with the Shopify id — or mark failed, keeping the handle so
 *      the retry lands on the same product.
 *
 * The crash-visible intermediate state is deliberate. A draft stuck in
 * `publishing` means "we reserved an identity and do not know what Shopify did
 * with it" — which is exactly the case a human needs to look at, and is
 * indistinguishable from success if you only write the status at the end.
 *
 * Every one of those transitions writes an `events` row (from inside the SQL
 * functions, so nothing can move a draft without leaving a trace).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import type { ShopifyClient } from '@/lib/shopify/client'
import { ShopifyError } from '@/lib/shopify/errors'
import { primaryLocationId, productSet } from '@/lib/shopify/product-set'

import { paiseToShopifyPrice } from './identity'
import type {
  CategoryRow,
  DraftRow,
  PublishInput,
  PublishOptions,
  PublishResult,
  ReservedIdentity,
} from './types'
import { assertPublishable, resolveWeightG } from './validate'

/** Written on every product. The live store has `jewelery` / `Jewelery` / blank. */
export const PRODUCT_TYPE = 'Jewellery'

const DRAFT_COLUMNS =
  'id, category_id, material_id, title_suffix, price_paise, weight_g, stock, status, reserved_sku, reserved_handle, shopify_product_id'
const CATEGORY_COLUMNS =
  'id, name, sku_prefix, title_pattern, shopify_tag, default_weight_g, default_stock'

export async function loadPublishInput(
  db: SupabaseClient,
  draftId: string,
): Promise<PublishInput> {
  const { data: draft, error: draftError } = await db
    .from('product_drafts')
    .select(DRAFT_COLUMNS)
    .eq('id', draftId)
    .single<DraftRow>()
  if (draftError || !draft) {
    throw new Error(`No product_draft ${draftId}: ${draftError?.message ?? 'not found'}`)
  }

  const { data: category, error: categoryError } = await db
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .eq('id', draft.category_id)
    .single<CategoryRow>()
  if (categoryError || !category) {
    throw new Error(
      `Draft ${draftId} points at category ${draft.category_id}, which does not exist: ` +
        (categoryError?.message ?? 'not found'),
    )
  }

  let materialName: string | null = null
  if (draft.material_id) {
    const { data, error } = await db
      .from('materials')
      .select('name')
      .eq('id', draft.material_id)
      .single<{ name: string }>()
    if (error || !data) throw new Error(`Draft ${draftId} has an unknown material: ${error?.message}`)
    materialName = data.name
  }

  const { data: variantRows, error: variantError } = await db
    .from('product_draft_variants')
    .select('position, colours ( name )')
    .eq('product_draft_id', draftId)
    .order('position', { ascending: true })
  if (variantError) {
    throw new Error(`Could not read colours for draft ${draftId}: ${variantError.message}`)
  }

  // PostgREST returns an embedded many-to-one as an object, but supabase-js types
  // it as an array. Accept both rather than casting through `unknown` and being
  // wrong at runtime in whichever direction we did not expect.
  const colours = (variantRows ?? [])
    .map((row) => {
      const embedded = (row as { colours?: unknown }).colours
      const one = Array.isArray(embedded) ? embedded[0] : embedded
      return (one as { name?: unknown } | null | undefined)?.name
    })
    .filter((name): name is string => typeof name === 'string' && name.length > 0)

  return { draft, category, materialName, colours }
}

/**
 * Reserves (or reuses) the SKU and handle. One round trip, one transaction — the
 * number from `next_sku()` and the row that records it cannot come apart.
 */
export async function reserveIdentity(
  db: SupabaseClient,
  draftId: string,
  actor?: string,
): Promise<ReservedIdentity> {
  const { data, error } = await db
    .rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: actor ?? null })
    .select()
    .single<{
      draft_id: string
      sku: string
      sku_number: number
      handle: string
      title: string
      shopify_tag: string
      reused: boolean
    }>()

  if (error || !data) {
    throw new Error(
      `reserve_draft_identity failed for ${draftId}: ${error?.message ?? 'no row returned'}` +
        (error?.hint ? `\n  → ${error.hint}` : ''),
    )
  }

  return {
    draftId: data.draft_id,
    sku: data.sku,
    skuNumber: data.sku_number,
    handle: data.handle,
    title: data.title,
    shopifyTag: data.shopify_tag,
    reused: data.reused,
  }
}

export async function publishProduct(
  db: SupabaseClient,
  shopify: ShopifyClient,
  draftId: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const input = await loadPublishInput(db, draftId)

  // Before anything is reserved. A blocked publish must not burn a SKU number,
  // and must say every reason at once (hard rule 8).
  assertPublishable(input, options)

  const weightG = resolveWeightG(input)
  if (weightG === null) throw new Error('unreachable: validation guarantees a weight')
  if (input.draft.price_paise === null) throw new Error('unreachable: validation guarantees a price')

  const identity = await reserveIdentity(db, draftId, options.actor)

  try {
    const locationId = await primaryLocationId(shopify)
    const price = paiseToShopifyPrice(input.draft.price_paise)

    const variants =
      input.colours.length > 0
        ? input.colours.map((colour) => ({
            sku: identity.sku,
            price,
            weightG,
            stock: input.draft.stock,
            locationId,
            colour,
          }))
        : [{ sku: identity.sku, price, weightG, stock: input.draft.stock, locationId }]

    const product = await productSet(shopify, {
      handle: identity.handle,
      title: identity.title,
      productType: PRODUCT_TYPE,
      tags: [identity.shopifyTag, ...(options.extraTags ?? [])],
      material: input.materialName,
      colours: input.colours,
      variants,
    })

    const { error } = await db.rpc('mark_draft_published', {
      p_draft_id: draftId,
      p_shopify_product_id: product.id,
      p_actor: options.actor ?? null,
    })
    if (error) {
      // Shopify has the product; we failed to record it. Do not swallow this —
      // an unrecorded publish is how the same product gets published twice later.
      throw new Error(
        `Product ${product.id} was published but the draft could not be marked published: ` +
          `${error.message}. Reconcile by handle "${identity.handle}".`,
      )
    }

    return {
      draftId,
      shopifyProductId: product.id,
      sku: identity.sku,
      handle: identity.handle,
      title: identity.title,
      shopifyTag: identity.shopifyTag,
      productType: PRODUCT_TYPE,
      priceRupees: price,
      weightG,
      stock: input.draft.stock,
      material: input.materialName,
      colours: input.colours,
      reusedIdentity: identity.reused,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const retryable = cause instanceof ShopifyError ? cause.retryable : null

    // Records `failed` and KEEPS reserved_sku / reserved_handle. That is what makes
    // the retry reuse the handle and produce one product rather than two.
    const { error } = await db.rpc('mark_draft_failed', {
      p_draft_id: draftId,
      p_error: message,
      p_retryable: retryable,
      p_actor: options.actor ?? null,
    })
    if (error) {
      throw new Error(
        `Publish failed (${message}) AND the draft could not be marked failed (${error.message}). ` +
          `Draft ${draftId} is stranded in "publishing" — look at it.`,
      )
    }
    throw cause
  }
}
