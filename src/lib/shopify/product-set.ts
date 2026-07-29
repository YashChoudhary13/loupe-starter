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
import { ShopifyError } from './errors'

/** Namespace/key the theme reads the material from. See docs/DECISIONS.md D6. */
export const MATERIAL_METAFIELD = {
  namespace: 'custom',
  key: 'material',
  type: 'single_line_text_field',
} as const

/** Colour is a product OPTION; the variants under it share the parent SKU. */
export const COLOUR_OPTION_NAME = 'Colour'

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

export interface ProductSetVariant {
  readonly sku: string
  readonly price: string
  readonly weightG: number
  readonly stock: number
  readonly locationId: string
  readonly colour?: string
}

export interface ProductSetArgs {
  readonly handle: string
  readonly title: string
  readonly productType: string
  readonly tags: readonly string[]
  readonly material: string | null
  readonly colours: readonly string[]
  readonly variants: readonly ProductSetVariant[]
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

function buildInput(args: ProductSetArgs): Record<string, unknown> {
  const hasColours = args.colours.length > 0

  const variants = args.variants.map((variant, index) => ({
    // Every colour variant carries the SAME SKU. That is the live store's
    // convention (AK011 sits on both Gold and Silver) and CLAUDE.md says to keep
    // it — Shopify does not enforce SKU uniqueness, so it is allowed.
    sku: variant.sku,
    price: variant.price,
    position: index + 1,
    taxable: true,
    optionValues: variant.colour
      ? [{ optionName: COLOUR_OPTION_NAME, name: variant.colour }]
      : [{ optionName: DEFAULT_OPTION_NAME, name: DEFAULT_OPTION_VALUE }],
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
    // docs/DECISIONS.md D7 — the console IS the approval step. No Shopify draft stage.
    status: 'ACTIVE',
    tags: [...args.tags],
    // NO descriptionHtml. The six bullets render from the theme using the material
    // metafield (D6). Writing body copy here is how the live catalogue ended up
    // with WhatsApp CSS classes pasted into it.
    ...(args.material
      ? { metafields: [{ ...MATERIAL_METAFIELD, value: args.material }] }
      : {}),
    // ALWAYS present. productSet rejects `variants` without `productOptions`, so a
    // colourless product declares Shopify's own Title/Default Title pair rather
    // than omitting the field.
    productOptions: hasColours
      ? [{ name: COLOUR_OPTION_NAME, values: args.colours.map((name) => ({ name })) }]
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
      status
      productType
      tags
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
  readonly status: string
  readonly productType: string | null
  readonly tags: readonly string[]
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
