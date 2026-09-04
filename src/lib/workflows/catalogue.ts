import 'server-only'

import type { ShopifyClient } from '@/lib/shopify/client'

/** The whole store, not only Loupe-published products: admin duplicates are the point. */
export interface CatalogueProduct {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'
  readonly tags: readonly string[]
  readonly descriptionHtml: string
  readonly createdAt: string
  readonly seoTitle: string
  readonly seoDescription: string
  /** `custom.material` metafield value, or null when the product has none. */
  readonly material: string | null
}

const CATALOGUE_QUERY = /* GraphQL */ `
  query LoupeWorkflowCatalogue($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title status tags descriptionHtml createdAt
        seo { title description }
        metafield(namespace: "custom", key: "material") { value }
      }
    }
  }
`

interface CataloguePage {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: readonly {
      id: string
      handle: string
      title: string
      status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'
      tags: readonly string[]
      descriptionHtml: string | null
      createdAt: string
      seo: { title: string | null; description: string | null } | null
      metafield: { value: string | null } | null
    }[]
  }
}

export async function readCatalogue(
  client: ShopifyClient,
  progress?: (count: number) => Promise<void>,
): Promise<CatalogueProduct[]> {
  const products: CatalogueProduct[] = []
  let cursor: string | null = null
  for (;;) {
    const page: CataloguePage = await client.graphql<CataloguePage>(CATALOGUE_QUERY, { cursor })
    for (const node of page.products.nodes) {
      products.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        status: node.status,
        tags: node.tags,
        descriptionHtml: node.descriptionHtml ?? '',
        createdAt: node.createdAt,
        seoTitle: node.seo?.title ?? '',
        seoDescription: node.seo?.description ?? '',
        material: node.metafield?.value?.trim() || null,
      })
    }
    if (progress) await progress(products.length)
    if (!page.products.pageInfo.hasNextPage || !page.products.pageInfo.endCursor) return products
    cursor = page.products.pageInfo.endCursor
  }
}

/** Visible text of a description, entities decoded, whitespace collapsed. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
