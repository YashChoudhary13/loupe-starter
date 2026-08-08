/**
 * The `productSet` mutation — the whole Shopify write path.
 *
 * WHY `productSet` AND NOT `productCreate`
 *
 *   `productSet` is declarative and takes an `identifier`, so the same call
 *   creates the product the first time and updates it on every retry. That is
 *   CLAUDE.md hard rule 2 in one API call: reserve a handle, then always address
 *   the product BY that handle. `productCreate` would make a second product every
 *   time a publish was retried, and Shopify would accept it silently — the live
 *   store's `…-copy` handles are what that looks like after a year.
 *
 * `synchronous: true` matters too. The async form returns a job id and a product
 * that does not exist yet, so `mark_draft_published` would be recording an id for
 * something that might still fail. Volume here is ~300/month; there is nothing to
 * gain by not waiting.
 */
import type { ShopifyClient } from './client'
import { SHOPIFY_COLOUR_METAFIELD } from './colour-options'
import { ShopifyError } from './errors'

/** Namespace/key the theme reads the material from. See docs/DECISIONS.md D6. */
export const MATERIAL_METAFIELD = {
  namespace: 'custom',
  key: 'material',
  type: 'single_line_text_field',
} as const

/** Shopify's native category attribute uses the American-spelled option name. */
export const COLOUR_OPTION_NAME = 'Color'
/** Number is used for tray photographs where customers pick the labelled piece. */
export const NUMBER_OPTION_NAME = 'Number'
/** Ring size is a customer choice with independent inventory per size. */
export const SIZE_OPTION_NAME = 'Size'

/**
 * What Shopify calls the single option of a product that has no real options.
 *
 * `productSet` REQUIRES `productOptions` whenever `variants` are supplied —
 * *"Product options input is required when updating variants"* — so a product with
 * no colours cannot simply omit them and pass an empty `optionValues`. It has to
 * declare the same `Title` / `Default Title` pair Shopify creates internally for a
 * single-variant product. Anything else invents a visible option nobody asked for.
 */
export const DEFAULT_OPTION_NAME = 'Title'
export const DEFAULT_OPTION_VALUE = 'Default Title'

/**
 * Shopify's own cap on alt text. Longer than this and `productSet` rejects the
 * whole product, so a 100-word description has to be trimmed before it is sent —
 * see `buildAltText`, which does it deterministically and says when it did.
 */
export const ALT_TEXT_MAX_LENGTH = 512

export interface ProductSetVariant {
  readonly sku: string
  readonly price: string
  readonly weightG: number
  readonly stock: number
  readonly locationId: string
  readonly optionValue?: string
  /** Native saved-colour metaobject ID; present only for Color variants. */
  readonly linkedMetafieldValue?: string
  /** One product file to feature when this exact variant is selected. */
  readonly file?: ProductSetFile
}

/**
 * One image on the product, in the operator's order.
 *
 * `mediaId` is the whole idempotency story. When it is set, `productSet` is told
 * to keep THAT file at this position and simply correct its alt text; when it is
 * null the image is uploaded from `originalSource`. Sending `originalSource`
 * again for a file Shopify already holds uploads a second copy — the presigned
 * URL is different every time, so nothing on Shopify's side can tell they are
 * the same picture. That is how a retried publish grows duplicate media.
 */
export interface ProductSetFile {
  readonly mediaId: string | null
  /** Presigned, short-lived, and only used when `mediaId` is null. */
  readonly originalSource: string | null
  readonly filename: string
  readonly alt: string
}

export interface ProductSetArgs {
  readonly handle: string
  /**
   * D60 (supersedes D7): 'DRAFT' is Save Draft pushing an unfinished product to
   * Shopify; 'ACTIVE' is Publish putting it in the live catalogue. Publish must
   * always send ACTIVE — a product left DRAFT is invisible to buyers.
   */
  readonly status?: 'ACTIVE' | 'DRAFT'
  readonly title: string
  readonly productType: string
  readonly tags: readonly string[]
  readonly descriptionHtml: string
  readonly material: string | null
  /** Required for native Shopify category-linked Color options. */
  readonly categoryId?: string | null
  /** Null means Shopify's own Title / Default Title single variant. */
  readonly optionName:
    | typeof COLOUR_OPTION_NAME
    | typeof NUMBER_OPTION_NAME
    | typeof SIZE_OPTION_NAME
    | null
  readonly variants: readonly ProductSetVariant[]
  /**
   * Omitted entirely when the caller has no opinion about images — `productSet`
   * is declarative, so sending `files: []` would DELETE every image on the
   * product rather than leaving it alone.
   */
  readonly files?: readonly ProductSetFile[]
}

export interface AltText {
  readonly value: string
  /** True when the cached description was too long for Shopify and was trimmed. */
  readonly truncated: boolean
  /** True when there was no cached description and the product title was used. */
  readonly fallback: boolean
}

/**
 * The alt text for one image.
 *
 * The cached `intake_files.product_description` is used verbatim wherever it
 * fits — it is a factual description of that exact photograph, written once and
 * paid for once (D36), and it is why the console makes no model call.
 *
 * Two deterministic departures, both recorded rather than silent:
 *
 *   too long   trimmed at the last sentence that fits, else the last word. No
 *              ellipsis: alt text is read aloud, and "…" is noise in a screen
 *              reader. Nothing is added, only dropped from the end.
 *   missing    the product's own title. It invents no jewellery detail, which is
 *              the entire risk here — a fabricated "gold-plated" in alt text is a
 *              claim Qimati's retailers would be entitled to rely on.
 */
export function buildAltText(description: string | null, productTitle: string): AltText {
  const text = description?.trim() ?? ''
  if (!text) {
    return { value: `${productTitle} — product photograph`, truncated: false, fallback: true }
  }
  if (text.length <= ALT_TEXT_MAX_LENGTH) {
    return { value: text, truncated: false, fallback: false }
  }

  const window = text.slice(0, ALT_TEXT_MAX_LENGTH)
  const lastSentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '))
  if (lastSentence > ALT_TEXT_MAX_LENGTH / 2) {
    return { value: window.slice(0, lastSentence + 1), truncated: true, fallback: false }
  }

  const lastWord = window.lastIndexOf(' ')
  return {
    value: (lastWord > 0 ? window.slice(0, lastWord) : window).trimEnd(),
    truncated: true,
    fallback: false,
  }
}

export interface ShopifyProductSummary {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly status: string
  readonly productType: string | null
  readonly tags: readonly string[]
}

const PRODUCT_SET_MUTATION = /* GraphQL */ `
  mutation LoupeProductSet($identifier: ProductSetIdentifiers!, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product {
        id
        handle
        title
        status
        productType
        tags
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`

const PRIMARY_LOCATION_QUERY = /* GraphQL */ `
  query LoupePrimaryLocation {
    locations(first: 10, includeInactive: false, includeLegacy: false) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
      }
    }
  }
`

interface LocationsResponse {
  locations: {
    nodes: readonly {
      id: string
      name: string
      isActive: boolean
      fulfillsOnlineOrders: boolean
    }[]
  }
}

interface ProductSetResponse {
  productSet: {
    product: ShopifyProductSummary | null
    userErrors: readonly { field?: readonly string[] | null; message: string; code?: string | null }[]
  } | null
}

const MATERIAL_METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation LoupeMaterialMetafieldSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`

const MATERIAL_METAFIELDS_DELETE_MUTATION = /* GraphQL */ `
  mutation LoupeMaterialMetafieldDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        ownerId
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`

interface MaterialMetafieldSetResponse {
  metafieldsSet: {
    metafields: readonly { id: string }[] | null
    userErrors: readonly { field?: readonly string[] | null; message: string; code?: string | null }[]
  } | null
}

interface MaterialMetafieldDeleteResponse {
  metafieldsDelete: {
    deletedMetafields: readonly {
      ownerId: string
      namespace: string
      key: string
    }[] | null
    userErrors: readonly { field?: readonly string[] | null; message: string }[]
  } | null
}

function materialError(action: 'save' | 'clear', errors: readonly { field?: readonly string[] | null; message: string }[]): ShopifyError {
  return new ShopifyError(
    `Shopify could not ${action} the product material: ` +
      errors.map((error) => `${(error.field ?? []).join('.') || '(no field)'}: ${error.message}`).join('; '),
    { kind: 'user_error', retryable: false, detail: errors },
  )
}

/**
 * Material is ALWAYS written here, never through `productSet.metafields`.
 *
 * `productSet` treats its metafield list as declarative, so sending only
 * `custom.material` tries to delete every other metafield on the product. When
 * one of those is connected to an option, Shopify rejects the whole mutation
 * with "This metafield is connected to an option. To make changes, edit the
 * option."
 *
 * Native Color was the known case: it owns `shopify.color-pattern`, and the
 * original fix excluded metafields for Color products only. That was too narrow.
 * Shopify links a category metafield **by itself** whenever an option name
 * matches one the product's taxonomy category defines — a ring published with
 * Size options gets `shopify.ring-size` linked with nothing in Loupe asking for
 * it, and every such publish failed:
 *
 *     productSet rejected the product "rings-228": input: This metafield is
 *     connected to an option. To make changes, edit the option.
 *     Metafield Namespace: shopify, Metafield Key: ring-size
 *
 * There is no list of which category defines which option metafield, and it
 * grows as Shopify extends the taxonomy — so an allowlist of affected option
 * names would be wrong again the next time. Keeping material out of `productSet`
 * unconditionally removes the whole class. It costs one extra mutation on the
 * products that were previously exempt, which is what Color products already
 * paid. See D91.
 */
export async function syncMaterialMetafield(
  client: ShopifyClient,
  productId: string,
  material: string | null,
): Promise<void> {
  if (material) {
    const response = await client.graphql<MaterialMetafieldSetResponse>(
      MATERIAL_METAFIELDS_SET_MUTATION,
      {
        metafields: [{ ownerId: productId, ...MATERIAL_METAFIELD, value: material }],
      },
    )
    const result = response.metafieldsSet
    if (!result || result.userErrors.length > 0 || !result.metafields?.[0]?.id) {
      throw materialError('save', result?.userErrors ?? [{ message: 'No metafield was returned.' }])
    }
    return
  }

  const response = await client.graphql<MaterialMetafieldDeleteResponse>(
    MATERIAL_METAFIELDS_DELETE_MUTATION,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: MATERIAL_METAFIELD.namespace,
          key: MATERIAL_METAFIELD.key,
        },
      ],
    },
  )
  const result = response.metafieldsDelete
  if (!result || result.userErrors.length > 0) {
    throw materialError('clear', result?.userErrors ?? [{ message: 'No delete result was returned.' }])
  }
}

/**
 * The location inventory is counted against. Cached per client: it does not change,
 * and asking for it on every publish would double the request count of a 20-way
 * parallel publish for no reason.
 */
const locationCache = new WeakMap<ShopifyClient, Promise<string>>()

export function primaryLocationId(client: ShopifyClient): Promise<string> {
  let pending = locationCache.get(client)
  if (!pending) {
    pending = client.graphql<LocationsResponse>(PRIMARY_LOCATION_QUERY).then((data) => {
      const nodes = data.locations?.nodes ?? []
      const chosen = nodes.find((n) => n.isActive && n.fulfillsOnlineOrders) ?? nodes[0]
      if (!chosen) {
        throw new ShopifyError('The store has no active location, so stock cannot be set.', {
          kind: 'graphql',
          retryable: false,
          hint: 'Shopify admin → Settings → Locations. A store with no location cannot hold inventory.',
        })
      }
      return chosen.id
    })
    locationCache.set(client, pending)
  }
  return pending
}

export function buildInput(args: ProductSetArgs): Record<string, unknown> {
  const hasOptions = args.optionName !== null
  const nativeColour = args.optionName === COLOUR_OPTION_NAME
  const nativeColourValues = nativeColour
    ? args.variants.map((variant) => variant.linkedMetafieldValue!)
    : []

  if (nativeColour && !args.categoryId) {
    throw new Error('A native Shopify Color option requires a taxonomy category id.')
  }
  if (nativeColour && args.variants.some((variant) => !variant.linkedMetafieldValue)) {
    throw new Error('Every native Shopify Color variant requires a saved-colour metaobject id.')
  }

  const fileInput = (file: ProductSetFile) =>
    file.mediaId
      ? { id: file.mediaId, alt: file.alt }
      : {
          originalSource: file.originalSource,
          filename: file.filename,
          contentType: 'IMAGE',
          alt: file.alt,
        }

  const variants = args.variants.map((variant, index) => ({
    // Every option variant carries the SAME parent SKU. That is the live store's
    // convention for colours and remains the convention for numbered trays.
    sku: variant.sku,
    price: variant.price,
    position: index + 1,
    taxable: true,
    optionValues:
      variant.optionValue && args.optionName
        ? [
            nativeColour
              ? {
                  optionName: args.optionName,
                  linkedMetafieldValue: variant.linkedMetafieldValue,
                }
              : { optionName: args.optionName, name: variant.optionValue },
          ]
        : [{ optionName: DEFAULT_OPTION_NAME, name: DEFAULT_OPTION_VALUE }],
    ...(variant.file ? { file: fileInput(variant.file) } : {}),
    inventoryItem: {
      sku: variant.sku,
      tracked: true,
      // Grams, explicitly. Every live variant weighs 0, which is why weight-based
      // shipping does not work there; publish blocks on an unknown weight rather
      // than repeating it (src/lib/publish/validate.ts).
      measurement: { weight: { value: variant.weightG, unit: 'GRAMS' } },
    },
    inventoryQuantities: [
      { locationId: variant.locationId, name: 'available', quantity: variant.stock },
    ],
  }))

  return {
    handle: args.handle,
    title: args.title,
    productType: args.productType,
    // D60 supersedes D7: Save Draft pushes DRAFT, Publish pushes ACTIVE.
    // Defaulting to ACTIVE keeps every existing caller (and the Phase 2
    // verifier) publishing live products exactly as before.
    status: args.status ?? 'ACTIVE',
    tags: [...args.tags],
    // D50: clean generated HTML only. The console accepts plain text and escapes
    // it before it reaches this boundary, so pasted storefront markup cannot
    // leak into a product.
    descriptionHtml: args.descriptionHtml,
    ...(args.categoryId ? { category: args.categoryId } : {}),
    // NO metafields, ever. The list is declarative, so naming only material
    // tries to delete whatever else is on the product — and Shopify links a
    // category metafield to any option whose name it recognises (color-pattern
    // for Color, ring-size for Size), then refuses the mutation outright.
    // productSet() writes material in its own mutation after this succeeds.
    // See syncMaterialMetafield and D91.
    // Present only when the caller supplied images. `files` is declarative like
    // everything else in productSet, so listing them in draft order IS the
    // ordering instruction, and an omitted field is "leave the media alone"
    // while an empty array is "remove all of it".
    ...(args.files
      ? {
          files: args.files.map(fileInput),
        }
      : {}),
    // ALWAYS present. productSet rejects `variants` without `productOptions`, so a
    // colourless product declares Shopify's own Title/Default Title pair rather
    // than omitting the field.
    productOptions: hasOptions
      ? [
          nativeColour
            ? {
                name: args.optionName,
                // OptionSetInput.values accepts only ordinary named values.
                // Native Color metaobject IDs belong on the linked metafield;
                // each variant then selects one via linkedMetafieldValue.
                linkedMetafield: {
                  ...SHOPIFY_COLOUR_METAFIELD,
                  values: nativeColourValues,
                },
              }
            : {
                name: args.optionName,
                values: args.variants.map((variant) => ({ name: variant.optionValue! })),
              },
        ]
      : [{ name: DEFAULT_OPTION_NAME, values: [{ name: DEFAULT_OPTION_VALUE }] }],
    variants,
  }
}

export async function productSet(
  client: ShopifyClient,
  args: ProductSetArgs,
): Promise<ShopifyProductSummary> {
  const data = await client.graphql<ProductSetResponse>(PRODUCT_SET_MUTATION, {
    // THE idempotency key. Addressing by handle is what makes a retry update the
    // half-published product instead of creating a twin.
    identifier: { handle: args.handle },
    input: buildInput(args),
  })

  const result = data.productSet
  if (!result) {
    throw new ShopifyError('productSet returned no payload.', {
      kind: 'malformed',
      retryable: false,
      detail: data,
    })
  }

  if (result.userErrors.length > 0) {
    // userErrors mean OUR input was wrong. Never retryable: the same input will
    // fail identically for as long as we are willing to send it (hard rule 4).
    throw new ShopifyError(
      `productSet rejected the product "${args.handle}": ` +
        result.userErrors
          .map((e) => `${(e.field ?? []).join('.') || '(no field)'}: ${e.message}`)
          .join('; '),
      { kind: 'user_error', retryable: false, detail: result.userErrors },
    )
  }

  if (!result.product?.id) {
    throw new ShopifyError('productSet reported no errors but returned no product.', {
      kind: 'malformed',
      retryable: false,
      detail: result,
    })
  }

  await syncMaterialMetafield(client, result.product.id, args.material)

  return result.product
}

// ---------------------------------------------------------------------------
// Read-back helpers. Used by npm run verify:publish to prove what is actually in
// the store rather than trusting the mutation's own reply.
// ---------------------------------------------------------------------------

const PRODUCT_BY_HANDLE_QUERY = /* GraphQL */ `
  query LoupeProductByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      handle
      title
      # Ownership: a product Loupe made for a draft cannot predate that draft.
      # See publish/handle-ownership.ts.
      createdAt
      status
      productType
      tags
      descriptionHtml
      metafield(namespace: "custom", key: "material") {
        value
      }
      variants(first: 50) {
        nodes {
          id
          sku
          price
          selectedOptions {
            name
            value
          }
          inventoryQuantity
          inventoryItem {
            measurement {
              weight {
                value
                unit
              }
            }
          }
        }
      }
    }
  }
`

export interface ProductReadback {
  readonly id: string
  readonly handle: string
  readonly title: string
  /** Used to tell an interrupted Loupe publish from a hand-made product. */
  readonly createdAt: string | null
  readonly status: string
  readonly productType: string | null
  readonly tags: readonly string[]
  readonly descriptionHtml: string
  readonly metafield: { value: string } | null
  readonly variants: {
    readonly nodes: readonly {
      readonly id: string
      readonly sku: string | null
      readonly price: string
      readonly selectedOptions: readonly { name: string; value: string }[]
      readonly inventoryQuantity: number | null
      readonly inventoryItem: {
        measurement: { weight: { value: number; unit: string } | null } | null
      } | null
    }[]
  }
}

export async function readProductByHandle(
  client: ShopifyClient,
  handle: string,
): Promise<ProductReadback | null> {
  const data = await client.graphql<{ productByIdentifier: ProductReadback | null }>(
    PRODUCT_BY_HANDLE_QUERY,
    { handle },
  )
  return data.productByIdentifier
}

const PRODUCT_MEDIA_QUERY = /* GraphQL */ `
  query LoupeProductMedia($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      media(first: 50) {
        nodes {
          id
          alt
          mediaContentType
          status
          ... on MediaImage {
            image {
              url
              width
              height
            }
          }
        }
      }
    }
  }
`

export interface ShopifyMedia {
  readonly id: string
  readonly alt: string | null
  readonly mediaContentType: string
  readonly status: string
  readonly image: { url: string; width: number | null; height: number | null } | null
}

/**
 * The product's media, in Shopify's order.
 *
 * Read before publishing as well as after: before, so an interrupted publish can
 * reuse what it already uploaded instead of uploading it again; after, so the
 * ids can be recorded and so the order can actually be verified rather than
 * assumed from the fact that the mutation returned no errors.
 */
export async function readProductMedia(
  client: ShopifyClient,
  handle: string,
): Promise<readonly ShopifyMedia[] | null> {
  const data = await client.graphql<{
    productByIdentifier: { id: string; media: { nodes: readonly ShopifyMedia[] } } | null
  }>(PRODUCT_MEDIA_QUERY, { handle })
  if (!data.productByIdentifier) return null
  return data.productByIdentifier.media.nodes
}

const COUNT_BY_HANDLE_QUERY = /* GraphQL */ `
  query LoupeCountByHandle($query: String!) {
    productsCount(query: $query) {
      count
    }
  }
`

/**
 * How many products the store holds for a handle. This is THE idempotency
 * assertion: after publishing twice it must be 1.
 */
export async function countProductsByHandle(
  client: ShopifyClient,
  handle: string,
): Promise<number> {
  const data = await client.graphql<{ productsCount: { count: number } }>(COUNT_BY_HANDLE_QUERY, {
    query: `handle:${handle}`,
  })
  return data.productsCount.count
}

const DELETE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation LoupeProductDelete($id: ID!) {
    productDelete(input: { id: $id }) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`

export async function deleteProduct(client: ShopifyClient, id: string): Promise<string | null> {
  const data = await client.graphql<{
    productDelete: {
      deletedProductId: string | null
      userErrors: readonly { message: string }[]
    } | null
  }>(DELETE_PRODUCT_MUTATION, { id })

  const errors = data.productDelete?.userErrors ?? []
  if (errors.length > 0) {
    throw new ShopifyError(
      `productDelete failed for ${id}: ${errors.map((e) => e.message).join('; ')}`,
      { kind: 'user_error', retryable: false, detail: errors },
    )
  }
  return data.productDelete?.deletedProductId ?? null
}
