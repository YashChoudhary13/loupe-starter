import type { ShopifyClient } from './client'

export interface CodeMatch {
  readonly id: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly product: { readonly id: string; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' }
}

/** Shopify does not enforce barcode or SKU uniqueness. Always verify exact values. */
export async function findCodeMatches(client: ShopifyClient, code: string | readonly string[]): Promise<CodeMatch[]> {
  const codes = typeof code === 'string' ? [code] : code
  const matches: CodeMatch[] = []
  // One search per 20 codes: a many-variant product costs one round trip, not one per variant (D139).
  for (let start = 0; start < codes.length; start += 20) {
    const batch = codes.slice(start, start + 20)
    const query = `(${batch.map(c => `sku:${JSON.stringify(c)} OR barcode:${JSON.stringify(c)}`).join(' OR ')})`
    let after: string | null = null
    let complete = false
    for (let page = 0; page < 20 && !complete; page++) {
      const data: { productVariants: { nodes: CodeMatch[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await client.graphql(`
        query LoupeCodeMatches($query: String!, $after: String) {
          productVariants(first: 100, query: $query, after: $after) {
            nodes { id sku barcode product { id status } }
            pageInfo { hasNextPage endCursor }
          }
        }`, { query, after })
      matches.push(...data.productVariants.nodes.filter(v => (v.sku !== null && batch.includes(v.sku)) || (v.barcode !== null && batch.includes(v.barcode))))
      const next = data.productVariants.pageInfo.endCursor
      if (!data.productVariants.pageInfo.hasNextPage) complete = true
      else if (!next || next === after) break
      else after = next
    }
    if (!complete) throw new Error('Too many matching product codes. Resolve the duplicate codes before continuing.')
  }
  return matches
}

export async function assertVariantCodesAvailable(client: ShopifyClient, codes: readonly string[], productId: string | null): Promise<void> {
  if (new Set(codes).size !== codes.length) throw new Error('Each variant needs a distinct SKU and barcode.')
  const taken = (await findCodeMatches(client, codes)).find(match => match.product.id !== productId)
  if (taken) {
    const code = codes.find(c => c === taken.sku || c === taken.barcode)
    throw new Error(`Code ${code} already belongs to another Shopify product. Resolve the collision before publishing.`)
  }
}
