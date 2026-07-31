import type { ActualReconciliationProduct } from '@/lib/reconciliation/compare'

import type { ShopifyClient } from './client'

const RECONCILIATION_PRODUCTS_QUERY = /* GraphQL */ `
  query LoupeReconciliationProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        status
        productType
        tags
        descriptionHtml
        metafield(namespace: "custom", key: "material") {
          value
        }
        variants(first: 50) {
          nodes {
            sku
            price
            selectedOptions {
              name
              value
            }
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
        media(first: 50) {
          nodes {
            id
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
