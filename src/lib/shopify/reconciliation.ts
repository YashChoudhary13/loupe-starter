import type { ActualReconciliationProduct } from '@/lib/reconciliation/compare'

import type { ShopifyClient } from './client'

/**
 * Identity and variant structure only — reconciliation compares what Loupe owns
 * rather than what the business edits in admin (D90). Gone from this query:
 * `status`, `productType`, `tags`, `descriptionHtml`, the material metafield,
 * per-variant price and weight, and 50 media per product.
 *
 * `title` is fetched for the message text alone; nothing compares it.
 */
const RECONCILIATION_PRODUCTS_QUERY = /* GraphQL */ `
  query LoupeReconciliationProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        variants(first: 100) {
          nodes {
            sku
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`

const BATCH_SIZE = 50

export async function readProductsForReconciliation(
  client: ShopifyClient,
  ids: readonly string[],
): Promise<Map<string, ActualReconciliationProduct | null>> {
  const result = new Map<string, ActualReconciliationProduct | null>()
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const batch = ids.slice(offset, offset + BATCH_SIZE)
    const data = await client.graphql<{
      nodes: readonly (ActualReconciliationProduct | null)[]
    }>(RECONCILIATION_PRODUCTS_QUERY, { ids: batch })
    batch.forEach((id, index) => result.set(id, data.nodes[index] ?? null))
  }
  return result
}
