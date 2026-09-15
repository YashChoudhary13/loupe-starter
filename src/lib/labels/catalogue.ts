import type { ShopifyClient } from '@/lib/shopify/client'
import { findCodeMatches } from '@/lib/shopify/barcode-lookup'
import { parentSku } from '@/lib/publish/variant-sku'

export interface LabelVariant {
  readonly id: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly title: string
  readonly inventoryQuantity: number | null
  readonly product: { readonly id: string; readonly title: string }
}

const FIELDS = 'id sku barcode title inventoryQuantity product { id title }'

export async function searchLabelVariants(client: ShopifyClient, raw: string): Promise<LabelVariant[]> {
  const code = raw.trim().toUpperCase()
  if (!/^[A-Z]{2,4}\d+(?:-[A-Z0-9-]+)?$/.test(code) || code.length > 64) {
    throw new Error('Enter a product SKU such as NK1333 or an exact variant SKU.')
  }
  const found: LabelVariant[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page++) {
    const data: { productVariants: { nodes: LabelVariant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await client.graphql(`
      query LoupeLabelSearch($query: String!, $after: String) {
        productVariants(first: 100, query: $query, after: $after) {
          nodes { ${FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`, { query: `(sku:${JSON.stringify(code)} OR sku:${code}-*)`, after })
    found.push(...data.productVariants.nodes.filter(v => v.sku?.toUpperCase() === code || parentSku(v.sku ?? '') === code))
    if (!data.productVariants.pageInfo.hasNextPage) return found
    const next = data.productVariants.pageInfo.endCursor
    if (!next || next === after) break
    after = next
  }
  throw new Error('Too many matches. Enter a more specific SKU.')
}

/** Always reread saved values at print time; browser-supplied text is not authoritative. */
export async function readLabelVariants(client: ShopifyClient, ids: readonly string[]): Promise<LabelVariant[]> {
  const data = await client.graphql<{ nodes: (LabelVariant | null)[] }>(`
    query LoupeLabelVariants($ids: [ID!]!) {
      nodes(ids: $ids) { ... on ProductVariant { ${FIELDS} } }
    }`, { ids })
  if (data.nodes.length !== ids.length || data.nodes.some((v, i) => !v || v.id !== ids[i])) {
    throw new Error('A selected variant no longer exists. Refresh the label list and select it again.')
  }
  return data.nodes as LabelVariant[]
}

export async function verifyLabelCodes(client: ShopifyClient, variants: readonly LabelVariant[]): Promise<void> {
  for (const variant of variants) {
    if (!variant.barcode) throw new Error(`${variant.sku ?? variant.title} has no saved barcode. Assign it in Shopify first.`)
    const matches = await findCodeMatches(client, variant.barcode)
    if (!matches.some(v => v.id === variant.id && v.barcode === variant.barcode) || matches.some(v => v.id !== variant.id)) {
      throw new Error(`Barcode ${variant.barcode} is missing or also identifies another variant. Resolve it before printing.`)
    }
  }
}
