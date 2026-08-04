import { describe, expect, it, vi } from 'vitest'

import type { ShopifyClient } from '@/lib/shopify/client'
import { syncShopifySavedColours } from '@/lib/shopify/colour-options'
import { ShopifyError } from '@/lib/shopify/errors'

function client(graphql: ReturnType<typeof vi.fn>): ShopifyClient {
  return { graphql } as unknown as ShopifyClient
}

describe('Shopify native Color default entries', () => {
  it('reuses the merchant’s saved colour without changing its swatch', async () => {
    const graphql = vi.fn().mockResolvedValueOnce({
      metaobjects: {
        nodes: [
          {
            id: 'gid://shopify/Metaobject/red',
            handle: 'red',
            displayName: 'Red',
            fields: [
              { key: 'label', value: 'Red' },
              { key: 'color', value: '#ff0000' },
            ],
          },
        ],
      },
    })

    await expect(syncShopifySavedColours(client(graphql), ['Red'])).resolves.toEqual([
      { name: 'Red', metaobjectId: 'gid://shopify/Metaobject/red' },
    ])
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('reuses Shopify Multicolor for Loupe’s Multi Colour label', async () => {
    const graphql = vi.fn().mockResolvedValueOnce({
      metaobjects: {
        nodes: [
          {
            id: 'gid://shopify/Metaobject/multicolor',
            handle: 'multicolor',
            displayName: 'Multicolor',
            fields: [
              { key: 'label', value: 'Multicolor' },
              { key: 'image', value: 'gid://shopify/MediaImage/multicolor-swatch' },
            ],
          },
        ],
      },
    })

    await expect(syncShopifySavedColours(client(graphql), ['Multi Colour'])).resolves.toEqual([
      { name: 'Multi Colour', metaobjectId: 'gid://shopify/Metaobject/multicolor' },
    ])
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('creates a missing simple colour with Shopify taxonomy references', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ metaobjects: { nodes: [] } })
      .mockResolvedValueOnce({
        metaobjectUpsert: {
          metaobject: {
            id: 'gid://shopify/Metaobject/gold',
            handle: 'loupe-gold',
            displayName: 'Gold',
          },
          userErrors: [],
        },
      })

    await expect(syncShopifySavedColours(client(graphql), ['Gold'])).resolves.toEqual([
      { name: 'Gold', metaobjectId: 'gid://shopify/Metaobject/gold' },
    ])

    expect(graphql.mock.calls[1]?.[1]).toMatchObject({
      handle: { type: 'shopify--color-pattern', handle: 'loupe-gold' },
      metaobject: {
        fields: expect.arrayContaining([
          { key: 'label', value: 'Gold' },
          { key: 'color', value: '#d4af37' },
          {
            key: 'color_taxonomy_reference',
            value: '["gid://shopify/TaxonomyValue/4"]',
          },
        ]),
      },
    })
  })

  it('explains the one-time Shopify setup when native Color entries are not active', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ metaobjects: { nodes: [] } })
      .mockResolvedValueOnce({
        metaobjectUpsert: {
          metaobject: null,
          userErrors: [
            {
              field: ['metaobject'],
              message: 'No metaobject definition exists for type "shopify--color-pattern"',
            },
          ],
        },
      })

    await expect(syncShopifySavedColours(client(graphql), ['Red'])).rejects.toMatchObject({
      name: 'ShopifyError',
      kind: 'user_error',
      message: expect.stringContaining(
        'Shopify’s built-in Color entries are not active for this store yet.',
      ),
      hint: expect.stringContaining('Default entries'),
    } satisfies Partial<ShopifyError>)

    expect(graphql).toHaveBeenCalledTimes(2)
  })

  it('refuses to invent a flat swatch for a missing multi-colour value', async () => {
    const graphql = vi.fn().mockResolvedValueOnce({ metaobjects: { nodes: [] } })

    await expect(syncShopifySavedColours(client(graphql), ['Red / White'])).rejects.toMatchObject({
      name: 'ShopifyError',
      kind: 'user_error',
    } satisfies Partial<ShopifyError>)
    expect(graphql).toHaveBeenCalledTimes(1)
  })
})
