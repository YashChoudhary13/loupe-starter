/**
 * Sales-channel publication.
 *
 * `productSet` has no publications field, so a product created by Loupe lands on
 * no sales channel until `publishablePublish` runs. Before this existed, every
 * product had to be ticked into Online Store, Point of Sale and Google & YouTube
 * by hand in Shopify admin. These tests pin the three things that would make
 * that regress silently: which publications are chosen, that the query cannot
 * truncate the list, and that a refusal is loud rather than swallowed.
 */
import { describe, expect, it, vi } from 'vitest'

import type { ShopifyClient } from '../src/lib/shopify/client'
import { ShopifyError } from '../src/lib/shopify/errors'
import { publishToSalesChannels, salesChannels } from '../src/lib/shopify/publications'

/** Shaped like the live store: Online Store, POS, Google & YouTube, one custom. */
function publicationsPage(
  nodes: readonly { id: string; status: string; title?: string | null }[],
  hasNextPage = false,
) {
  return {
    publications: {
      pageInfo: { hasNextPage },
      nodes: nodes.map((node) => ({
        id: node.id,
        catalog: {
          status: node.status,
          apps: { nodes: node.title === null ? [] : [{ title: node.title ?? 'Channel' }] },
        },
      })),
    },
  }
}

const LIVE_CHANNELS = [
  { id: 'gid://shopify/Publication/1', status: 'ACTIVE', title: 'Online Store' },
  { id: 'gid://shopify/Publication/2', status: 'ACTIVE', title: 'Point of Sale' },
  { id: 'gid://shopify/Publication/3', status: 'ACTIVE', title: 'Google & YouTube' },
]

function stub(...responses: readonly unknown[]) {
  const graphql = vi.fn()
  for (const response of responses) graphql.mockResolvedValueOnce(response)
  return { graphql, client: { graphql } as unknown as ShopifyClient }
}

describe('sales channels', () => {
  it('asks only for APP catalogs — Markets and B2B are a different decision', async () => {
    const { graphql, client } = stub(publicationsPage(LIVE_CHANNELS))
    await salesChannels(client)

    const query = graphql.mock.calls[0]?.[0] as string
    expect(query).toContain('catalogType: APP')
    // MARKET and COMPANY_LOCATION publications are Markets and B2B price lists.
    // Publishing to those has different commercial consequences and is not what
    // "make the sales channels active" means.
    expect(query).not.toContain('MARKET')
    expect(query).not.toContain('COMPANY_LOCATION')
  })

  it('skips archived and draft catalogs — a channel that is not selling', async () => {
    const { client } = stub(
      publicationsPage([
        ...LIVE_CHANNELS,
        { id: 'gid://shopify/Publication/9', status: 'ARCHIVED', title: 'Old channel' },
        { id: 'gid://shopify/Publication/10', status: 'DRAFT', title: 'Half-installed' },
      ]),
    )

    expect((await salesChannels(client)).map((channel) => channel.name)).toEqual([
      'Online Store',
      'Point of Sale',
      'Google & YouTube',
    ])
  })

  it('names a channel by its id when the catalog exposes no app title', async () => {
    const { client } = stub(
      publicationsPage([{ id: 'gid://shopify/Publication/7', status: 'ACTIVE', title: null }]),
    )
    // The name is only ever shown to a human. Falling back keeps a nameless
    // channel in the publish list rather than dropping it for cosmetics.
    expect(await salesChannels(client)).toEqual([
      { id: 'gid://shopify/Publication/7', name: 'gid://shopify/Publication/7' },
    ])
  })

  it('refuses a truncated list rather than publishing to some of the channels', async () => {
    const { client } = stub(publicationsPage(LIVE_CHANNELS, true))
    // Silently taking the first page would mean a channel stops receiving
    // products with nothing anywhere saying so.
    await expect(salesChannels(client)).rejects.toThrow(/more than 100 sales channels/i)
  })

  it('asks once per client, however many products a batch publishes', async () => {
    const { graphql, client } = stub(publicationsPage(LIVE_CHANNELS))
    graphql.mockResolvedValue({ publishablePublish: { userErrors: [] } })

    await publishToSalesChannels(client, 'gid://shopify/Product/1')
    await publishToSalesChannels(client, 'gid://shopify/Product/2')
    await publishToSalesChannels(client, 'gid://shopify/Product/3')

    // One publications query, three publishes — not six calls.
    expect(graphql).toHaveBeenCalledTimes(4)
    expect(graphql.mock.calls.filter((call) => (call[0] as string).includes('publications')))
      .toHaveLength(1)
  })
})

describe('publishToSalesChannels', () => {
  it('publishes one product to every active channel in a single mutation', async () => {
    const { graphql, client } = stub(publicationsPage(LIVE_CHANNELS), {
      publishablePublish: { userErrors: [] },
    })

    const published = await publishToSalesChannels(client, 'gid://shopify/Product/970')

    expect(published.map((channel) => channel.name)).toEqual([
      'Online Store',
      'Point of Sale',
      'Google & YouTube',
    ])
    expect(graphql.mock.calls[1]?.[1]).toEqual({
      id: 'gid://shopify/Product/970',
      input: [
        { publicationId: 'gid://shopify/Publication/1' },
        { publicationId: 'gid://shopify/Publication/2' },
        { publicationId: 'gid://shopify/Publication/3' },
      ],
    })
  })

  it('makes no mutation call at all when the store has no active channel', async () => {
    const { graphql, client } = stub(
      publicationsPage([{ id: 'gid://shopify/Publication/9', status: 'ARCHIVED' }]),
    )

    // Not an error: a store nobody has finished setting up must not block a
    // publish for a reason the operator cannot act on from the console.
    expect(await publishToSalesChannels(client, 'gid://shopify/Product/1')).toEqual([])
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('throws a non-retryable error naming the scope when Shopify refuses', async () => {
    const { client } = stub(publicationsPage(LIVE_CHANNELS), {
      publishablePublish: {
        userErrors: [{ field: ['input', '0'], message: 'Access denied for publishablePublish.' }],
      },
    })

    // Swallowing this is the exact failure being fixed — a product that reports
    // "published" while reaching no channel.
    const error = await publishToSalesChannels(client, 'gid://shopify/Product/1').catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(ShopifyError)
    expect((error as ShopifyError).retryable).toBe(false)
    expect((error as Error).message).toContain('input.0: Access denied')
    expect((error as Error).message).toContain('write_publications')
  })

  it('throws rather than reporting success when the payload is missing', async () => {
    const { client } = stub(publicationsPage(LIVE_CHANNELS), { publishablePublish: null })
    await expect(publishToSalesChannels(client, 'gid://shopify/Product/1')).rejects.toThrow(
      /no payload/i,
    )
  })
})
