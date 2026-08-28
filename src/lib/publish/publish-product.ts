/**
 * publishProduct() — the Shopify write path.
 *
 * The sequence, and why it is this order (CLAUDE.md hard rules 1, 2 and 8):
 *
 *   1. Load the draft, its category, its material and its customer choices.
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
import { syncShopifySavedColours } from '@/lib/shopify/colour-options'
import { registerAfterPublish } from '@/lib/match/register'
import { supersedeAfterPublish } from '@/lib/match/supersede'
import { ShopifyError } from '@/lib/shopify/errors'
import {
  buildAltText,
  COLOUR_OPTION_NAME,
  NUMBER_OPTION_NAME,
  SIZE_OPTION_NAME,
  primaryLocationId,
  productSet,
  readProductByHandle,
  readProductMedia,
  type ProductSetFile,
  type ProductSetVariant,
} from '@/lib/shopify/product-set'
import { publishToSalesChannels } from '@/lib/shopify/publications'

import { buildDescriptionHtml, isControlledMaterial } from './description'
import { buildSeo } from './seo'
import { assertHandleIsWritable, classifyHandleOwnership } from './handle-ownership'
import { paiseToShopifyPrice } from './identity'
import { clearCounterOfShopifyNumbers } from './shopify-numbering'
import type {
  CategoryRow,
  DraftRow,
  PublishedImage,
  PublishImage,
  PublishInput,
  PublishOptions,
  PublishResult,
  ReservedIdentity,
} from './types'
import { assertPublishable, resolveWeightG, totalAvailableStock } from './validate'

/** Written on every product. The live store has `jewelery` / `Jewelery` / blank. */
export const PRODUCT_TYPE = 'Jewellery'

/**
 * Written on every product alongside its category tag.
 *
 * The live catalogue uses this exact all-caps spelling. Collections are
 * tag-driven, so "Newest", "newest" or "New" would all publish successfully
 * while silently missing the intended collection.
 */
export const NEWEST_TAG = 'NEWEST'

/**
 * Category tag, NEWEST, then the material tag when it is one of the three
 * controlled names. The theme's product-card badge ("Material badge (Qimati)")
 * and the material collections read the tags `304` / `316L` / `Brass`, so a
 * product published without one shows no badge. A custom material is not a
 * store tag and is deliberately not written as one.
 */
export function buildProductTags(
  categoryTag: string,
  extraTags: readonly string[] = [],
  material: string | null = null,
): readonly string[] {
  const clean = material?.trim().replace(/\s+/g, ' ') ?? ''
  const materialTags = isControlledMaterial(clean) ? [clean] : []
  return [categoryTag, NEWEST_TAG, ...materialTags, ...extraTags]
}

/**
 * Shopify validates a file's declared filename extension against the bytes it
 * fetches from `originalSource`. Generated versions are PNGs even when their
 * source photograph was a JPEG, so the intake filename cannot be reused
 * verbatim for every selected version.
 */
export function filenameForStorage(sourceFilename: string, storageKey: string): string {
  const storageName = storageKey.split('/').at(-1) ?? ''
  const extension = storageName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (!extension) return sourceFilename

  const base = sourceFilename.replace(/\.[^.]+$/, '')
  return `${base || sourceFilename}.${extension}`
}

const DRAFT_COLUMNS =
  'id, category_id, material_id, custom_material, description_override, title_suffix, price_paise, weight_g, stock, variant_kind, status, reserved_sku, reserved_handle, shopify_product_id, created_at'
const CATEGORY_COLUMNS =
  'id, name, sku_prefix, title_pattern, shopify_tag, shopify_taxonomy_category_id, default_weight_g, default_stock'

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

  let materialName: string | null = draft.custom_material
  if (!materialName && draft.material_id) {
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
    .select('position, option_value, stock')
    .eq('product_draft_id', draftId)
    .order('position', { ascending: true })
  if (variantError) {
    throw new Error(`Could not read variants for draft ${draftId}: ${variantError.message}`)
  }

  const variants = (
    (variantRows ?? []) as { option_value: string; stock: number; position: number }[]
  ).map((row) => ({ value: row.option_value, stock: row.stock }))

  return { draft, category, materialName, variants, images: await loadPublishImages(db, draftId) }
}

/**
 * The draft's images, in the operator's order, each carrying the cached
 * description of the photograph it came from.
 *
 * Two joins deep on purpose: the image is a version, the description belongs to
 * the source file, and the alt text has to be the description of *that* source
 * photograph rather than of whichever one happened to be first.
 */
export async function loadPublishImages(
  db: SupabaseClient,
  draftId: string,
): Promise<readonly PublishImage[]> {
  const { data, error } = await db
    .from('product_draft_images')
    .select(
      'image_version_id, position, shopify_media_id, colours ( name ), image_versions ( id, storage_key, intake_file_id, intake_files ( id, filename, product_description ) )',
    )
    .eq('product_draft_id', draftId)
    .order('position', { ascending: true })
  if (error) throw new Error(`Could not read images for draft ${draftId}: ${error.message}`)

  const one = <T,>(value: unknown): T | null =>
    (Array.isArray(value) ? (value[0] as T | undefined) : (value as T | undefined)) ?? null

  return (data ?? [])
    .map((row) => {
      const record = row as {
        image_version_id: string
        position: number
        shopify_media_id: string | null
        colours?: unknown
        image_versions?: unknown
      }
      const version = one<{ id: string; storage_key: string; intake_file_id: string; intake_files?: unknown }>(
        record.image_versions,
      )
      if (!version) return null
      const file = one<{ id: string; filename: string; product_description: string | null }>(
        version.intake_files,
      )
      const colour = one<{ name: string }>(record.colours)

      return {
        imageVersionId: record.image_version_id,
        intakeFileId: version.intake_file_id,
        position: record.position,
        storageKey: version.storage_key,
        description: file?.product_description ?? null,
        shopifyMediaId: record.shopify_media_id,
        colourValue: colour?.name ?? null,
        filename: filenameForStorage(
          file?.filename ?? version.intake_file_id,
          version.storage_key,
        ),
      }
    })
    .filter((image): image is PublishImage => image !== null)
}

/**
 * Turns the draft's images into `productSet` file inputs, reusing what Shopify
 * already holds wherever it can.
 *
 * Three cases, in priority order:
 *
 *   1. we recorded a media id for this image and Shopify still has it → reuse,
 *      which is what makes a REORDER move the picture rather than upload it
 *      again beside itself;
 *   2. NOTHING is recorded for any image, and the product already carries exactly
 *      as many media as we are about to send → assume they are ours in order and
 *      repair them. This is the crash window: media created, ids never written
 *      down;
 *   3. otherwise upload from a freshly presigned URL.
 *
 * Case 2 is deliberately all-or-nothing. A MIXED set — some ids recorded, one
 * not — is not a crash, it is an edit: the usual way an image loses its id is the
 * operator swapping which version to publish, which replaces the row. Repairing
 * by position there would silently republish the version they just rejected, so
 * the narrow rule is the safe one and one extra upload is the worst case.
 */
export async function buildProductFiles(
  images: readonly PublishImage[],
  existingMedia: readonly { id: string; status?: string }[] | null,
  productTitle: string,
  signImageUrl: (storageKey: string) => Promise<string>,
): Promise<{ files: readonly ProductSetFile[]; published: readonly PublishedImage[] }> {
  // Shopify keeps a MediaImage row when fetching its originalSource fails. Its
  // id is still returned by the product media query, but productSet rejects that
  // id if we try to associate it again. Treat FAILED media as absent so the
  // original object is uploaded again; PROCESSING media remain reusable because
  // that is the normal state immediately after a successful productSet call.
  const reusableMedia = (existingMedia ?? []).filter((media) => media.status !== 'FAILED')
  const known = new Set(reusableMedia.map((media) => media.id))
  const repairable =
    existingMedia !== null &&
    reusableMedia.length === images.length &&
    images.every((image) => image.shopifyMediaId === null)

  const files: ProductSetFile[] = []
  const published: PublishedImage[] = []

  for (const [index, image] of images.entries()) {
    const alt = buildAltText(image.description, productTitle)

    let mediaId: string | null = null
    if (image.shopifyMediaId && known.has(image.shopifyMediaId)) {
      mediaId = image.shopifyMediaId
    } else if (repairable) {
      mediaId = reusableMedia[index]?.id ?? null
    }

    files.push({
      mediaId,
      originalSource: mediaId ? null : await signImageUrl(image.storageKey),
      filename: image.filename,
      alt: alt.value,
    })
    published.push({
      imageVersionId: image.imageVersionId,
      shopifyMediaId: mediaId,
      alt: alt.value,
      altTruncated: alt.truncated,
      altFallback: alt.fallback,
      reused: mediaId !== null,
    })
  }

  return { files, published }
}

/**
 * Reserves (or reuses) the SKU and handle. One round trip, one transaction — the
 * number from `next_sku()` and the row that records it cannot come apart.
 */
/**
 * The counter's current `last_number`. The next number issued is this plus one.
 *
 * Read outside the reservation transaction on purpose: it only seeds the Shopify
 * probe. `next_sku()` remains the single atomic allocator, and `raise_sku_counter`
 * is monotone, so a stale read here can make the probe start low — costing an
 * extra probe — but can never issue a number twice.
 */
async function currentCounter(db: SupabaseClient, prefix: string): Promise<number> {
  const { data, error } = await db
    .from('sku_counters')
    .select('last_number')
    .eq('sku_prefix', prefix)
    .single<{ last_number: number }>()
  if (error || !data) {
    throw new Error(
      `No SKU counter for prefix ${prefix}: ${error?.message ?? 'not found'}. ` +
        'Confirm the category against the live store rather than inventing a sequence.',
    )
  }
  return data.last_number
}

export async function reserveIdentity(
  db: SupabaseClient,
  draftId: string,
  actor?: string,
  /**
   * False only for the Shopify DRAFT path (D60), which relaxes the price guard
   * because an unpriced product is exactly what a draft is. Every other
   * invariant — category, confirmed tag, D27 category pin — still applies.
   */
  requirePublishable = true,
): Promise<ReservedIdentity> {
  const { data, error } = await db
    .rpc('reserve_draft_identity', {
      p_draft_id: draftId,
      p_actor: actor ?? null,
      p_require_publishable: requirePublishable,
    })
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

/**
 * D97's publish-time guard, callable on its own: step the counter past any
 * number Shopify already uses, so the reservation that follows cannot collide
 * with a product listed by hand since the last scan. A no-op for a draft that
 * already holds its identity — that identity is frozen (hard rule 2), so
 * moving the counter would not change it.
 *
 * Hard rule 1 is intact: the number still comes from the atomic counter, and
 * Shopify is consulted only to rule candidates out. `raise_sku_counter` is
 * monotone, so this can never walk a sequence backwards.
 */
export async function stepCounterPastShopifyNumbers(
  db: SupabaseClient,
  shopify: ShopifyClient,
  input: Pick<PublishInput, 'draft' | 'category'>,
  actor?: string | null,
): Promise<void> {
  if (input.draft.reserved_sku) return

  const counter = await currentCounter(db, input.category.sku_prefix)
  const numbering = await clearCounterOfShopifyNumbers(
    shopify,
    {
      prefix: input.category.sku_prefix,
      titlePattern: input.category.title_pattern,
      titleSuffix: input.draft.title_suffix,
      counterLastNumber: counter,
    },
    async (prefix, to) => {
      const { error } = await db.rpc('raise_sku_counter', { p_prefix: prefix, p_to: to })
      if (error) throw new Error(`Could not raise the ${prefix} counter to ${to}: ${error.message}`)
    },
  )
  if (numbering.raisedTo !== null) {
    // Direct insert, like sync-sku-counters — there is no record_event RPC,
    // and stepping over somebody's hand-made numbers must leave a trace.
    await db.from('events').insert({
      entity_type: 'product_draft',
      entity_id: input.draft.id,
      event: 'publish.counter_advanced',
      detail: {
        prefix: input.category.sku_prefix,
        raised_to: numbering.raisedTo,
        next_free: numbering.nextFree,
        skipped: numbering.skipped,
      },
      actor: actor ?? null,
    })
  }
}

/**
 * Save-time identity (D107): probe, then reserve, inside the operator's click.
 *
 * Before this, "Save draft" answered with a PREDICTED SKU and the reservation
 * happened after the response, in the background push — so the moment the
 * category counter refreshed, the editor showed the reserved number plus one.
 * The operator writes these numbers on physical tags; the save response must
 * carry the identity `next_sku()` actually issued, not a guess (hard rule 8).
 *
 * The Shopify push still runs after the response. It finds this reservation
 * and reuses it (hard rule 2), exactly as a retry always has.
 */
export async function reserveIdentityForSave(
  db: SupabaseClient,
  shopify: ShopifyClient,
  draftId: string,
  actor?: string,
): Promise<ReservedIdentity> {
  const input = await loadPublishInput(db, draftId)
  await stepCounterPastShopifyNumbers(db, shopify, input, actor)
  return reserveIdentity(db, draftId, actor, false)
}

export async function publishProduct(
  db: SupabaseClient,
  shopify: ShopifyClient,
  draftId: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const input = await loadPublishInput(db, draftId)

  /**
   * D60. A Shopify DRAFT is an unfinished product on purpose: it may have no
   * price and no material yet, which is exactly why the operator is saving it
   * rather than publishing it. Publish (`ACTIVE`) is unchanged and still runs
   * every block in hard rule 8.
   */
  const asDraft = options.shopifyStatus === 'DRAFT'

  // Before anything is reserved. A blocked publish must not burn a SKU number,
  // and must say every reason at once (hard rule 8).
  if (!asDraft) assertPublishable(input, options)

  // D19: NULL weight means "nobody has said" and must never be coerced to 0 on
  // the publish path — assertPublishable() blocks it there, so this stays an
  // assertion. Only an unfinished Shopify DRAFT may stand in a 0, and the
  // ACTIVE path will still block it later if it is never answered.
  const resolvedWeightG = resolveWeightG(input)
  if (!asDraft && resolvedWeightG === null) {
    throw new Error('unreachable: validation guarantees a weight')
  }
  if (!asDraft && input.draft.price_paise === null) {
    throw new Error('unreachable: validation guarantees a price')
  }
  const weightG = resolvedWeightG ?? 0

  // Step the counter past any number Shopify already uses, before reserving —
  // D97, extracted into stepCounterPastShopifyNumbers so the save-time
  // reservation (reserveIdentityForSave) runs the identical guard.
  await stepCounterPastShopifyNumbers(db, shopify, input, options.actor)

  const identity = await reserveIdentity(db, draftId, options.actor, !asDraft)

  try {
    const locationId = await primaryLocationId(shopify)
    // A draft with no price yet goes to Shopify at 0.00 — Shopify requires a
    // number. It is never published at that figure: hard rule 8 blocks an
    // empty or zero price on the ACTIVE path, so this can only ever be a
    // placeholder the operator must replace before the product goes live.
    const price = paiseToShopifyPrice(input.draft.price_paise ?? 0)
    const descriptionHtml = buildDescriptionHtml(
      input.materialName,
      input.draft.description_override,
    )

    const optionName =
      input.draft.variant_kind === 'colour'
        ? COLOUR_OPTION_NAME
        : input.draft.variant_kind === 'number'
          ? NUMBER_OPTION_NAME
          : input.draft.variant_kind === 'size'
            ? SIZE_OPTION_NAME
            : null
    // An unfinished Shopify draft may have had its option mode selected before
    // the first row was added. Keep that draft saveable as one default variant;
    // ACTIVE validation blocks until the missing choices are supplied.
    const hasOptionRows = optionName !== null && input.variants.length > 0
    let variants: ProductSetVariant[] =
      hasOptionRows
        ? input.variants.map((variant) => ({
            sku: identity.sku,
            price,
            weightG,
            stock: variant.stock,
            locationId,
            optionValue: variant.value,
          }))
        : [{ sku: identity.sku, price, weightG, stock: input.draft.stock, locationId }]

    /**
     * Never write over a product Loupe did not create.
     *
     * `productSet` addresses by handle, which silently assumes the product there
     * is ours. On 2026-08-08 a hand-made `necklace-1007` occupied a handle Loupe
     * reserved; Shopify happened to refuse the write because of a linked Color
     * option, and that refusal is the only reason the product survived. A plain
     * hand-made product would have been overwritten with nothing said. See D97.
     */
    const occupant = await readProductByHandle(shopify, identity.handle)
    const ownership = classifyHandleOwnership(
      {
        handle: identity.handle,
        reservedSku: identity.sku,
        recordedProductId: input.draft.shopify_product_id,
        draftCreatedAt: input.draft.created_at,
      },
      occupant,
    )
    assertHandleIsWritable(
      {
        handle: identity.handle,
        reservedSku: identity.sku,
        recordedProductId: input.draft.shopify_product_id,
        draftCreatedAt: input.draft.created_at,
      },
      ownership,
    )

    // Read the store's media BEFORE writing. A publish that was interrupted
    // after Shopify accepted the files but before Loupe recorded their ids is
    // indistinguishable from a first attempt unless we look.
    let published: readonly PublishedImage[] = []
    let files: readonly ProductSetFile[] | undefined
    if (input.images.length > 0) {
      const signImageUrl = options.signImageUrl
      if (!signImageUrl) {
        throw new Error(
          `Draft ${draftId} has ${input.images.length} image(s) but no signImageUrl was supplied. ` +
            'Shopify fetches images over HTTP and the R2 bucket is private.',
        )
      }
      const existingMedia = await readProductMedia(shopify, identity.handle)
      const built = await buildProductFiles(input.images, existingMedia, identity.title, signImageUrl)
      files = built.files
      published = built.published
    }

    if (hasOptionRows && optionName === COLOUR_OPTION_NAME) {
      if (!input.category.shopify_taxonomy_category_id) {
        throw new Error(
          `${input.category.name} has no Shopify taxonomy category, so its Color option cannot use native saved swatches.`,
        )
      }

      const savedColours = await syncShopifySavedColours(
        shopify,
        input.variants.map((variant) => variant.value),
      )
      const metaobjectByName = new Map(
        savedColours.map((colour) => [colour.name.toLowerCase(), colour.metaobjectId]),
      )
      const fileByColour = new Map<string, ProductSetFile>()
      input.images.forEach((image, index) => {
        if (image.colourValue && files?.[index]) {
          fileByColour.set(image.colourValue.toLowerCase(), files[index])
        }
      })

      variants = variants.map((variant) => {
        const key = variant.optionValue?.toLowerCase() ?? ''
        return {
          ...variant,
          linkedMetafieldValue: metaobjectByName.get(key),
          ...(fileByColour.has(key) ? { file: fileByColour.get(key) } : {}),
        }
      })
    }

    const product = await productSet(shopify, {
      handle: identity.handle,
      title: identity.title,
      productType: PRODUCT_TYPE,
      tags: buildProductTags(identity.shopifyTag, options.extraTags, input.materialName),
      descriptionHtml,
      seo: buildSeo({
        skuPrefix: input.category.sku_prefix,
        skuNumber: identity.skuNumber,
        material: input.materialName,
        categoryName: input.category.name,
      }),
      material: input.materialName,
      categoryId: input.category.shopify_taxonomy_category_id,
      optionName: hasOptionRows ? optionName : null,
      variants,
      ...(asDraft ? { status: 'DRAFT' as const } : {}),
      ...(files ? { files } : {}),
    })

    /**
     * Sales channels, every time, for both the DRAFT and the ACTIVE path.
     *
     * `productSet` cannot carry publications (see publications.ts), so without
     * this a published product lands on no channel and somebody has to open
     * Shopify admin and tick Online Store, Point of Sale and Google & YouTube by
     * hand — which is the manual step Loupe exists to remove.
     *
     * Running it on the DRAFT path too is safe and deliberate: Shopify's DRAFT
     * status hides a product from buyers regardless of which channels it is
     * published to, so setting the channels early means the later Publish makes
     * it live everywhere at once with nothing left to remember.
     *
     * A failure here throws, and the catch below marks the draft `failed` while
     * keeping its handle. That is the same trade the media-id write already
     * makes: Shopify holds the product, Loupe says so in Tracking, and the retry
     * is idempotent — `productSet` updates the same product by handle and
     * `publishablePublish` is a no-op for channels it already has. A publish that
     * silently reached no channel is the failure mode being fixed, so it must not
     * be swallowed.
     */
    const channels = await publishToSalesChannels(shopify, product.id)

    // Read the media back so the recorded ids are Shopify's, not ours. Assuming
    // the mutation did what it was told is exactly how duplicate media survives
    // a green test run.
    if (input.images.length > 0) {
      const finalMedia = ((await readProductMedia(shopify, identity.handle)) ?? []).filter(
        (media) => media.status !== 'FAILED',
      )
      published = published.map((image, index) => ({
        ...image,
        shopifyMediaId: finalMedia[index]?.id ?? image.shopifyMediaId,
      }))

      const { error: mediaError } = await db.rpc('record_shopify_media', {
        p_draft_id: draftId,
        p_media: published.map((image) => ({
          image_version_id: image.imageVersionId,
          media_id: image.shopifyMediaId,
        })),
        p_actor: options.actor ?? null,
      })
      if (mediaError) {
        throw new Error(
          `Product ${product.id} was published but its image ids could not be recorded: ` +
            `${mediaError.message}. A retry would re-upload the images — reconcile by handle "${identity.handle}".`,
        )
      }
    }

    const { error } = asDraft
      ? await db.rpc('record_draft_shopify_product', {
          p_draft_id: draftId,
          p_shopify_product_id: product.id,
          p_actor: options.actor ?? null,
        })
      : await db.rpc('mark_draft_published', {
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

    // D111: the published original becomes a matcher reference. Best effort —
    // the weekly sweep catches anything this misses, and a publish that already
    // happened is never failed by it.
    if (!asDraft) {
      await registerAfterPublish(db, options.actor ?? 'publish')
      // D112: a new SKU born from a restock archives the product it replaces.
      await supersedeAfterPublish(db, shopify, draftId, options.actor ?? 'publish')
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
      stock: totalAvailableStock(input),
      material: input.materialName,
      descriptionHtml,
      variantKind: input.draft.variant_kind,
      variants: input.variants,
      reusedIdentity: identity.reused,
      images: published,
      salesChannels: channels,
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
