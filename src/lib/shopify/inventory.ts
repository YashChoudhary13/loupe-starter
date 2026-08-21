import type { ShopifyClient } from './client'
import { ShopifyError } from './errors'
import { primaryLocationId } from './product-set'

/**
 * The three Shopify writes a restock needs (D112): read a product's stock by
 * SKU, set available quantities, archive a product. Loupe otherwise never
 * touches inventory (D54) — these run only from the Restock section after a
 * human chose a path, and at publish for a supersession.
 */

export interface VariantStock {
  readonly variantId: string
  readonly inventoryItemId: string
  readonly label: string
  readonly quantity: number
}

export interface ProductStock {
  readonly productId: string
  readonly title: string
  readonly handle: string
  readonly status: string
  readonly variants: readonly VariantStock[]
}

const VARIANTS_BY_SKU = /* GraphQL */ `
  query LoupeVariantsBySku($query: String!) {
    productVariants(first: 25, query: $query) {
      nodes {
        id
        sku
        inventoryQuantity
        selectedOptions { name value }
        inventoryItem { id }
        product { id title handle status }
      }
    }
  }
`

interface VariantsBySkuResponse {
  productVariants: {
    nodes: {
      id: string
      sku: string | null
      inventoryQuantity: number | null
      selectedOptions: { name: string; value: string }[]
      inventoryItem: { id: string } | null
      product: { id: string; title: string; handle: string; status: string }
    }[]
  }
}

export function variantLabel(options: readonly { name: string; value: string }[]): string {
  const named = options.filter((o) => o.value !== 'Default Title')
  return named.length ? named.map((o) => o.value).join(' / ') : 'Default'
}

/** Every product carrying this SKU (Loupe's variants share the parent SKU). Active first. */
export async function readProductStockBySku(client: ShopifyClient, sku: string): Promise<ProductStock[]> {
  const data = await client.graphql<VariantsBySkuResponse>(VARIANTS_BY_SKU, { query: `sku:${JSON.stringify(sku)}` })
  const byProduct = new Map<string, ProductStock>()
  for (const node of data.productVariants?.nodes ?? []) {
    if ((node.sku ?? '').toUpperCase() !== sku.toUpperCase() || !node.inventoryItem) continue
    const current = byProduct.get(node.product.id) ?? {
      productId: node.product.id,
      title: node.product.title,
      handle: node.product.handle,
      status: node.product.status,
      variants: [],
    }
    byProduct.set(node.product.id, {
      ...current,
      variants: [
        ...current.variants,
        { variantId: node.id, inventoryItemId: node.inventoryItem.id, label: variantLabel(node.selectedOptions), quantity: node.inventoryQuantity ?? 0 },
      ],
    })
  }
  return [...byProduct.values()].sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE'))
}

const SET_QUANTITIES = /* GraphQL */ `
  mutation LoupeSetAvailable($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt reason }
      userErrors { field message code }
    }
  }
`

export function buildSetQuantitiesInput(
  locationId: string,
  items: readonly { inventoryItemId: string; quantity: number }[],
  referenceDocumentUri: string,
): Record<string, unknown> {
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      throw new Error(`Stock must be a whole number of 0 or more; got ${item.quantity}.`)
    }
  }
  return {
    name: 'available',
    reason: 'received',
    // Absolute quantities, idempotent on retry: Loupe sets what the operator typed.
    ignoreCompareQuantity: true,
    referenceDocumentUri,
    quantities: items.map((item) => ({ inventoryItemId: item.inventoryItemId, locationId, quantity: item.quantity })),
  }
}

export async function setAvailableQuantities(
  client: ShopifyClient,
  items: readonly { inventoryItemId: string; quantity: number }[],
  referenceDocumentUri: string,
): Promise<void> {
  if (items.length === 0) return
  const locationId = await primaryLocationId(client)
  const data = await client.graphql<{ inventorySetQuantities: { userErrors: { message: string; field?: string[]; code?: string }[] } }>(
    SET_QUANTITIES,
    { input: buildSetQuantitiesInput(locationId, items, referenceDocumentUri) },
  )
  const errors = data.inventorySetQuantities?.userErrors ?? []
  if (errors.length) {
    throw new ShopifyError(`Shopify refused the stock change: ${errors.map((e) => e.message).join('; ')}`, {
      kind: 'graphql',
      retryable: false,
    })
  }
}

const ARCHIVE_PRODUCT = /* GraphQL */ `
  mutation LoupeArchiveProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id status }
      userErrors { field message }
    }
  }
`

export async function archiveProduct(client: ShopifyClient, productId: string): Promise<string> {
  const data = await client.graphql<{ productUpdate: { product: { id: string; status: string } | null; userErrors: { message: string }[] } }>(
    ARCHIVE_PRODUCT,
    { product: { id: productId, status: 'ARCHIVED' } },
  )
  const errors = data.productUpdate?.userErrors ?? []
  if (errors.length) {
    throw new ShopifyError(`Shopify refused to archive ${productId}: ${errors.map((e) => e.message).join('; ')}`, {
      kind: 'graphql',
      retryable: false,
    })
  }
  return data.productUpdate?.product?.status ?? 'ARCHIVED'
}
