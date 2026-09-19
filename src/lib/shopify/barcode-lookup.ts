import type { ShopifyClient } from './client'

export interface CodeMatch {
  readonly id: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly product: { readonly id: string; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' }
}

/** Shopify does not enforce barcode or SKU uniqueness. Always verify exact values. */
export async function findCodeMatches(client: ShopifyClient, code: string): Promise<CodeMatch[]> {
  const matches: CodeMatch[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page++) {
    const data: { productVariants: { nodes: CodeMatch[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await client.graphql(`
      query LoupeCodeMatches($query: String!, $after: String) {
        productVariants(first: 100, query: $query, after: $after) {
          nodes { id sku barcode product { id status } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { query: `(sku:${JSON.stringify(code)} OR barcode:${JSON.stringify(code)})`, after })
    matches.push(...data.productVariants.nodes.filter(v => v.sku === code || v.barcode === code))
    if (!data.productVariants.pageInfo.hasNextPage) return matches
    const next = data.productVariants.pageInfo.endCursor
    if (!next || next === after) break
    after = next
  }
  throw new Error('Too many matching product codes. Resolve the duplicate codes before continuing.')
}

export async function assertVariantCodesAvailable(client: ShopifyClient, codes: readonly string[], productId: string | null): Promise<void> {
  if (new Set(codes).size !== codes.length) throw new Error('Each variant needs a distinct SKU and barcode.')
  for (const code of codes) {
    const matches = await findCodeMatches(client, code)
    if (matches.some(match => match.product.id !== productId)) {
      throw new Error(`Code ${code} already belongs to another Shopify product. Resolve the collision before publishing.`)
    }
  }
}
