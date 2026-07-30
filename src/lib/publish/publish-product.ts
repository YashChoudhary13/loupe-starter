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
import {
  buildAltText,
  primaryLocationId,
  productSet,
  readProductMedia,
  type ProductSetFile,
} from '@/lib/shopify/product-set'

import { buildDescriptionHtml } from './description'
import { paiseToShopifyPrice } from './identity'
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
import { assertPublishable, resolveWeightG } from './validate'

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

export function buildProductTags(
  categoryTag: string,
  extraTags: readonly string[] = [],
): readonly string[] {
  return [categoryTag, NEWEST_TAG, ...extraTags]
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
  'id, category_id, material_id, custom_material, description_override, title_suffix, price_paise, weight_g, stock, status, reserved_sku, reserved_handle, shopify_product_id'
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

  return { draft, category, materialName, colours, images: await loadPublishImages(db, draftId) }
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
      'image_version_id, position, shopify_media_id, image_versions ( id, storage_key, intake_file_id, intake_files ( id, filename, product_description ) )',
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
        image_versions?: unknown
      }
      const version = one<{ id: string; storage_key: string; intake_file_id: string; intake_files?: unknown }>(
        record.image_versions,
      )
      if (!version) return null
      const file = one<{ id: string; filename: string; product_description: string | null }>(
        version.intake_files,
      )

      return {
        imageVersionId: record.image_version_id,
        intakeFileId: version.intake_file_id,
        position: record.position,
        storageKey: version.storage_key,
        description: file?.product_description ?? null,
        shopifyMediaId: record.shopify_media_id,
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
  existingMedia: readonly { id: string }[] | null,
  productTitle: string,
  signImageUrl: (storageKey: string) => Promise<string>,
): Promise<{ files: readonly ProductSetFile[]; published: readonly PublishedImage[] }> {
  const known = new Set((existingMedia ?? []).map((m) => m.id))
  const repairable =
    existingMedia !== null &&
    existingMedia.length === images.length &&
    images.every((image) => image.shopifyMediaId === null)

  const files: ProductSetFile[] = []
  const published: PublishedImage[] = []

  for (const [index, image] of images.entries()) {
    const alt = buildAltText(image.description, productTitle)

    let mediaId: string | null = null
    if (image.shopifyMediaId && known.has(image.shopifyMediaId)) {
      mediaId = image.shopifyMediaId
    } else if (repairable) {
      mediaId = (existingMedia ?? [])[index]?.id ?? null
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
    const descriptionHtml = buildDescriptionHtml(
      input.materialName,
      input.draft.description_override,
    )

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

    const product = await productSet(shopify, {
      handle: identity.handle,
      title: identity.title,
      productType: PRODUCT_TYPE,
      tags: buildProductTags(identity.shopifyTag, options.extraTags),
      descriptionHtml,
      material: input.materialName,
      colours: input.colours,
      variants,
      ...(files ? { files } : {}),
    })

    // Read the media back so the recorded ids are Shopify's, not ours. Assuming
    // the mutation did what it was told is exactly how duplicate media survives
    // a green test run.
    if (input.images.length > 0) {
      const finalMedia = (await readProductMedia(shopify, identity.handle)) ?? []
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
      descriptionHtml,
      colours: input.colours,
      reusedIdentity: identity.reused,
      images: published,
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
