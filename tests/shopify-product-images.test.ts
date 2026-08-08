/**
 * Phase 4 · criteria 6, 10, 11, 12 and 13 — product images and alt text.
 *
 * `productSet`'s `files` is declarative, which is what makes ordering free and
 * duplication easy: passing `id` keeps a file Shopify already holds, passing
 * `originalSource` uploads a new one. The presigned R2 URL is different on every
 * publish, so nothing on Shopify's side can recognise a re-upload of the same
 * photograph — which means the ONLY thing standing between a retry and duplicate
 * media is `product_draft_images.shopify_media_id` (D47). That is what these
 * assertions are about.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  buildProductFiles,
  buildProductTags,
  filenameForStorage,
  NEWEST_TAG,
} from '@/lib/publish/publish-product'
import type { PublishImage } from '@/lib/publish/types'
import {
  ALT_TEXT_MAX_LENGTH,
  buildAltText,
  buildInput,
  productSet,
} from '@/lib/shopify/product-set'
import type { ShopifyClient } from '@/lib/shopify/client'

function image(overrides: Partial<PublishImage> = {}): PublishImage {
  return {
    imageVersionId: 'ver-1',
    intakeFileId: 'file-1',
    position: 0,
    storageKey: 'versions/file-1/v1.png',
    description: 'A single necklace in polished gold-tone metal.',
    shopifyMediaId: null,
    colourValue: null,
    filename: 'necklace.png',
    ...overrides,
  }
}

const sign = async (key: string) => `https://r2.example.com/${key}?X-Amz-Signature=deadbeef`

describe('product tags', () => {
  it('always writes the live catalogue’s exact NEWEST tag beside the category tag', () => {
    expect(NEWEST_TAG).toBe('NEWEST')
    expect(buildProductTags('Necklace')).toEqual(['Necklace', 'NEWEST'])
    expect(buildProductTags('earrings', ['loupe-test'])).toEqual([
      'earrings',
      'NEWEST',
      'loupe-test',
    ])
  })
})

describe('Shopify customer choices', () => {
  it('links native Color swatches and assigns the matching file to each variant', () => {
    const redFile = {
      mediaId: 'gid://shopify/MediaImage/red',
      originalSource: null,
      filename: 'red.png',
      alt: 'Red bracelet.',
    }
    const greenFile = {
      mediaId: null,
      originalSource: 'https://r2.example.com/green.png?sig=x',
      filename: 'green.png',
      alt: 'Green bracelet.',
    }
    const input = buildInput({
      handle: 'bracelet-033',
      title: 'Bracelet 033',
      status: 'DRAFT',
      productType: 'Jewellery',
      categoryId: 'gid://shopify/TaxonomyCategory/aa-6-3',
      tags: ['cb', 'NEWEST'],
      descriptionHtml: '<ul><li>316L</li></ul>',
      material: '316L',
      optionName: 'Color',
      files: [redFile, greenFile],
      variants: [
        {
          sku: 'CB033',
          price: '715.00',
          weightG: 0,
          stock: 2,
          locationId: 'gid://shopify/Location/1',
          optionValue: 'Red',
          linkedMetafieldValue: 'gid://shopify/Metaobject/red',
          file: redFile,
        },
        {
          sku: 'CB033',
          price: '715.00',
          weightG: 0,
          stock: 4,
          locationId: 'gid://shopify/Location/1',
          optionValue: 'Green',
          linkedMetafieldValue: 'gid://shopify/Metaobject/green',
          file: greenFile,
        },
      ],
    }) as {
      category: string
      metafields?: { namespace: string; key: string; type: string; value: string }[]
      productOptions: {
        name: string
        linkedMetafield: { namespace: string; key: string; values: string[] }
      }[]
      files: Record<string, unknown>[]
      variants: {
        optionValues: { optionName: string; linkedMetafieldValue: string }[]
        file: Record<string, unknown>
      }[]
    }

    expect(input.category).toBe('gid://shopify/TaxonomyCategory/aa-6-3')
    // Shopify rejects productSet.metafields on a product with a linked Color
    // option. Material is synchronized separately after productSet succeeds.
    expect(input.metafields).toBeUndefined()
    expect(input.productOptions).toEqual([
      {
        name: 'Color',
        linkedMetafield: {
          namespace: 'shopify',
          key: 'color-pattern',
          values: [
            'gid://shopify/Metaobject/red',
            'gid://shopify/Metaobject/green',
          ],
        },
      },
    ])
    expect(input.variants.map((variant) => variant.optionValues[0])).toEqual([
      { optionName: 'Color', linkedMetafieldValue: 'gid://shopify/Metaobject/red' },
      { optionName: 'Color', linkedMetafieldValue: 'gid://shopify/Metaobject/green' },
    ])
    expect(input.variants[0]?.file).toEqual({
      id: 'gid://shopify/MediaImage/red',
      alt: 'Red bracelet.',
    })
    expect(input.variants[1]?.file).toEqual(input.files[1])
  })

  it('updates native Color choices first, then saves material separately', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        productSet: {
          product: {
            id: 'gid://shopify/Product/364',
            handle: 'bracelet-kada-364',
            title: 'Bracelet Kada 364',
            status: 'DRAFT',
            productType: 'Jewellery',
            tags: ['kada', 'NEWEST'],
          },
          userErrors: [],
        },
      })
      .mockResolvedValueOnce({
        metafieldsSet: {
          metafields: [{ id: 'gid://shopify/Metafield/material' }],
          userErrors: [],
        },
      })
    const client = { graphql } as unknown as ShopifyClient

    await productSet(client, {
      handle: 'bracelet-kada-364',
      title: 'Bracelet Kada 364',
      status: 'DRAFT',
      productType: 'Jewellery',
      categoryId: 'gid://shopify/TaxonomyCategory/aa-6-3',
      tags: ['kada', 'NEWEST'],
      descriptionHtml: '<ul><li>316L</li></ul>',
      material: '316L',
      optionName: 'Color',
      variants: [
        {
          sku: 'BK364',
          price: '100.00',
          weightG: 0,
          stock: 1,
          locationId: 'gid://shopify/Location/1',
          optionValue: 'Silver',
          linkedMetafieldValue: 'gid://shopify/Metaobject/silver',
        },
        {
          sku: 'BK364',
          price: '100.00',
          weightG: 0,
          stock: 1,
          locationId: 'gid://shopify/Location/1',
          optionValue: 'Gold',
          linkedMetafieldValue: 'gid://shopify/Metaobject/gold',
        },
        {
          sku: 'BK364',
          price: '100.00',
          weightG: 0,
          stock: 1,
          locationId: 'gid://shopify/Location/1',
          optionValue: 'Yellow',
          linkedMetafieldValue: 'gid://shopify/Metaobject/yellow',
        },
      ],
    })

    expect(graphql).toHaveBeenCalledTimes(2)
    expect(graphql.mock.calls[0]?.[1]?.input).not.toHaveProperty('metafields')
    expect(graphql.mock.calls[0]?.[1]).toMatchObject({
      identifier: { handle: 'bracelet-kada-364' },
      input: {
        productOptions: [
          {
            name: 'Color',
            linkedMetafield: {
              namespace: 'shopify',
              key: 'color-pattern',
              values: [
                'gid://shopify/Metaobject/silver',
                'gid://shopify/Metaobject/gold',
                'gid://shopify/Metaobject/yellow',
              ],
            },
          },
        ],
      },
    })
    expect(graphql.mock.calls[1]?.[1]).toEqual({
      metafields: [
        {
          ownerId: 'gid://shopify/Product/364',
          namespace: 'custom',
          key: 'material',
          type: 'single_line_text_field',
          value: '316L',
        },
      ],
    })
  })

  /**
   * The rings-228 failure. Shopify links a category metafield to any option
   * whose name it recognises, with nothing in Loupe asking for it — a ring
   * published with Size options gets `shopify.ring-size` linked, and
   * `productSet.metafields` then tries to delete it:
   *
   *   productSet rejected the product "rings-228": input: This metafield is
   *   connected to an option. To make changes, edit the option.
   *   Metafield Namespace: shopify, Metafield Key: ring-size
   *
   * The original fix exempted Color only. Material now stays out of productSet
   * for every product. See D91.
   */
  it.each([
    ['Size', '7.5'],
    ['Number', '17'],
    [null, null],
  ] as const)('keeps material out of productSet for a %s product too', async (optionName, optionValue) => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        productSet: {
          product: {
            id: 'gid://shopify/Product/228',
            handle: 'rings-228',
            title: 'Rings 228',
            status: 'DRAFT',
            productType: 'Jewellery',
            tags: ['Rings', 'NEWEST'],
          },
          userErrors: [],
        },
      })
      .mockResolvedValueOnce({
        metafieldsSet: {
          metafields: [{ id: 'gid://shopify/Metafield/material' }],
          userErrors: [],
        },
      })
    const client = { graphql } as unknown as ShopifyClient

    await productSet(client, {
      handle: 'rings-228',
      title: 'Rings 228',
      status: 'DRAFT',
      productType: 'Jewellery',
      tags: ['Rings', 'NEWEST'],
      descriptionHtml: '<ul><li>316L</li></ul>',
      material: '316L',
      optionName,
      variants: [
        {
          sku: 'RS228',
          price: '100.00',
          weightG: 0,
          stock: 1,
          locationId: 'gid://shopify/Location/1',
          ...(optionValue ? { optionValue } : {}),
        },
      ],
    })

    expect(graphql.mock.calls[0]?.[1]?.input).not.toHaveProperty('metafields')
    expect(graphql).toHaveBeenCalledTimes(2)
    expect(graphql.mock.calls[1]?.[1]).toEqual({
      metafields: [
        {
          ownerId: 'gid://shopify/Product/228',
          namespace: 'custom',
          key: 'material',
          type: 'single_line_text_field',
          value: '316L',
        },
      ],
    })
  })

  it('saves numbered pieces as Shopify DRAFT variants with independent stock', () => {
    const input = buildInput({
      handle: 'rings-001',
      title: 'Rings 001',
      status: 'DRAFT',
      productType: 'Jewellery',
      tags: ['Rings', 'NEWEST'],
      descriptionHtml: '<ul><li>316L</li></ul>',
      material: '316L',
      optionName: 'Number',
      variants: [
        {
          sku: 'RS001',
          price: '750.00',
          weightG: 0,
          stock: 2,
          locationId: 'gid://shopify/Location/1',
          optionValue: '1',
        },
        {
          sku: 'RS001',
          price: '750.00',
          weightG: 0,
          stock: 7,
          locationId: 'gid://shopify/Location/1',
          optionValue: '2',
        },
      ],
    }) as {
      status: string
      productOptions: { name: string; values: { name: string }[] }[]
      variants: {
        sku: string
        optionValues: { optionName: string; name: string }[]
        inventoryQuantities: {
          locationId: string
          name: string
          quantity: number
        }[]
      }[]
    }

    expect(input.status).toBe('DRAFT')
    expect(input.productOptions).toEqual([
      { name: 'Number', values: [{ name: '1' }, { name: '2' }] },
    ])
    expect(input.variants.map((variant) => variant.sku)).toEqual(['RS001', 'RS001'])
    expect(input.variants.map((variant) => variant.optionValues[0])).toEqual([
      { optionName: 'Number', name: '1' },
      { optionName: 'Number', name: '2' },
    ])
    expect(input.variants.map((variant) => variant.inventoryQuantities[0])).toEqual([
      { locationId: 'gid://shopify/Location/1', name: 'available', quantity: 2 },
      { locationId: 'gid://shopify/Location/1', name: 'available', quantity: 7 },
    ])
  })

  it('saves ring sizes as Shopify DRAFT Size variants with independent stock', () => {
    const input = buildInput({
      handle: 'ring-002',
      title: 'Ring 002',
      status: 'DRAFT',
      productType: 'Jewellery',
      tags: ['Rings', 'NEWEST'],
      descriptionHtml: '<ul><li>316L</li></ul>',
      material: '316L',
      optionName: 'Size',
      variants: [
        {
          sku: 'RS002',
          price: '850.00',
          weightG: 0,
          stock: 3,
          locationId: 'gid://shopify/Location/1',
          optionValue: '6',
        },
        {
          sku: 'RS002',
          price: '850.00',
          weightG: 0,
          stock: 8,
          locationId: 'gid://shopify/Location/1',
          optionValue: '7.5',
        },
      ],
    }) as {
      status: string
      productOptions: { name: string; values: { name: string }[] }[]
      variants: {
        optionValues: { optionName: string; name: string }[]
        inventoryQuantities: { name: string; quantity: number }[]
      }[]
    }

    expect(input.status).toBe('DRAFT')
    expect(input.productOptions).toEqual([
      { name: 'Size', values: [{ name: '6' }, { name: '7.5' }] },
    ])
    expect(input.variants.map((variant) => variant.optionValues[0])).toEqual([
      { optionName: 'Size', name: '6' },
      { optionName: 'Size', name: '7.5' },
    ])
    expect(
      input.variants.map((variant) => variant.inventoryQuantities[0]?.quantity),
    ).toEqual([3, 8])
  })
})

describe('Shopify filenames', () => {
  it('uses the selected object extension, not the source photograph extension', () => {
    expect(
      filenameForStorage(
        'phase4-chain-bracelet.jpg',
        'versions/intake-id/v1.png',
      ),
    ).toBe('phase4-chain-bracelet.png')
    expect(
      filenameForStorage(
        'phase4-chain-bracelet.jpg',
        'originals/intake-id.jpg',
      ),
    ).toBe('phase4-chain-bracelet.jpg')
  })
})

describe('alt text', () => {
  it('is the cached description of THAT photograph, verbatim', async () => {
    const alt = buildAltText('A single necklace in polished gold-tone metal.', 'Necklace 005')
    expect(alt.value).toBe('A single necklace in polished gold-tone metal.')
    expect(alt.truncated).toBe(false)
    expect(alt.fallback).toBe(false)
  })

  it('trims a description longer than Shopify allows, at a sentence boundary', () => {
    // A real 60–100 word description lands close to 512 characters, so this is a
    // path production takes rather than a theoretical guard.
    const first = `${'A single necklace in polished gold-tone metal with round-cut stones. '.repeat(7)}`
    const alt = buildAltText(`${first}And a trailing clause that will not fit at all.`, 'Necklace 005')

    expect(alt.truncated).toBe(true)
    expect(alt.value.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH)
    // Nothing is added — no ellipsis, which is noise in a screen reader.
    expect(alt.value.endsWith('…')).toBe(false)
    expect(alt.value.endsWith('.')).toBe(true)
    // And nothing is invented: every word came from the description.
    expect(`${first}And a trailing clause that will not fit at all.`).toContain(alt.value)
  })

  it('falls back to a word boundary when there is no sentence to cut at', () => {
    const alt = buildAltText('word '.repeat(200).trim(), 'Necklace 005')
    expect(alt.truncated).toBe(true)
    expect(alt.value.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH)
    expect(alt.value.endsWith(' ')).toBe(false)
  })

  it('falls back to the product TITLE when the describer degraded — and invents nothing', () => {
    for (const missing of [null, '', '   ']) {
      const alt = buildAltText(missing, 'Necklace 005')
      expect(alt.fallback).toBe(true)
      expect(alt.value).toBe('Necklace 005 — product photograph')
      // Not the presentation class, not the filename, and no jewellery detail
      // that nobody wrote down (D48).
      expect(alt.value).not.toMatch(/flat-curve|gold|stone|plated/i)
    }
  })
})

describe('building the file list', () => {
  it('uploads from a presigned URL when Shopify holds nothing', async () => {
    const { files, published } = await buildProductFiles([image()], null, 'Necklace 005', sign)

    expect(files).toHaveLength(1)
    expect(files[0].mediaId).toBeNull()
    expect(files[0].originalSource).toContain('versions/file-1/v1.png')
    expect(files[0].filename).toBe('necklace.png')
    expect(files[0].alt).toBe('A single necklace in polished gold-tone metal.')
    expect(published[0].reused).toBe(false)
  })

  it('REUSES a recorded media id instead of uploading again — the retry case', async () => {
    const recorded = image({ shopifyMediaId: 'gid://shopify/MediaImage/1' })
    const { files, published } = await buildProductFiles(
      [recorded],
      [{ id: 'gid://shopify/MediaImage/1' }],
      'Necklace 005',
      sign,
    )

    expect(files[0].mediaId).toBe('gid://shopify/MediaImage/1')
    // No URL is minted at all, so there is nothing for Shopify to fetch twice.
    expect(files[0].originalSource).toBeNull()
    expect(published[0].reused).toBe(true)
  })

  it('MOVES a reused file when the operator reorders, rather than uploading beside it', async () => {
    const a = image({ imageVersionId: 'ver-a', intakeFileId: 'file-a', shopifyMediaId: 'gid://m/A' })
    const b = image({ imageVersionId: 'ver-b', intakeFileId: 'file-b', shopifyMediaId: 'gid://m/B' })

    // Shopify holds A then B; the operator has reordered to B then A.
    const { files } = await buildProductFiles(
      [b, a],
      [{ id: 'gid://m/A' }, { id: 'gid://m/B' }],
      'Necklace 005',
      sign,
    )

    expect(files.map((f) => f.mediaId)).toEqual(['gid://m/B', 'gid://m/A'])
    expect(files.every((f) => f.originalSource === null)).toBe(true)
  })

  it('REPAIRS the crash window: media exist, ids were never written down', async () => {
    // The publish that created them died before record_shopify_media ran. Sending
    // originalSource again would give the product six images instead of three.
    const images = [
      image({ imageVersionId: 'ver-1', intakeFileId: 'file-1' }),
      image({ imageVersionId: 'ver-2', intakeFileId: 'file-2' }),
      image({ imageVersionId: 'ver-3', intakeFileId: 'file-3' }),
    ]
    const existing = [{ id: 'gid://m/1' }, { id: 'gid://m/2' }, { id: 'gid://m/3' }]

    const { files, published } = await buildProductFiles(images, existing, 'Necklace 005', sign)

    expect(files.map((f) => f.mediaId)).toEqual(['gid://m/1', 'gid://m/2', 'gid://m/3'])
    expect(published.every((p) => p.reused)).toBe(true)
  })

  it('never reuses FAILED Shopify media during crash repair', async () => {
    const images = [
      image({ imageVersionId: 'ver-1', intakeFileId: 'file-1' }),
      image({ imageVersionId: 'ver-2', intakeFileId: 'file-2' }),
    ]
    const existing = [
      { id: 'gid://m/failed-1', status: 'FAILED' },
      { id: 'gid://m/failed-2', status: 'FAILED' },
    ]

    const { files, published } = await buildProductFiles(images, existing, 'Necklace 005', sign)

    expect(files.every((file) => file.mediaId === null)).toBe(true)
    expect(files.every((file) => file.originalSource !== null)).toBe(true)
    expect(published.every((image) => image.reused === false)).toBe(true)
  })

  it('continues to reuse PROCESSING media during crash repair', async () => {
    const processing = [{ id: 'gid://m/processing', status: 'PROCESSING' }]
    const { files } = await buildProductFiles([image()], processing, 'Necklace 005', sign)

    expect(files[0].mediaId).toBe('gid://m/processing')
    expect(files[0].originalSource).toBeNull()
  })

  it('does NOT guess when the counts disagree — it uploads instead', async () => {
    // The repair is deliberately narrow. Two of our images against one unknown
    // media could mean anything, and pairing the wrong picture with the wrong alt
    // text is worse than one extra file.
    const images = [
      image({ imageVersionId: 'ver-1', intakeFileId: 'file-1' }),
      image({ imageVersionId: 'ver-2', intakeFileId: 'file-2' }),
    ]
    const { files } = await buildProductFiles(images, [{ id: 'gid://m/1' }], 'Necklace 005', sign)
    expect(files.every((f) => f.mediaId === null)).toBe(true)
    expect(files.every((f) => f.originalSource !== null)).toBe(true)
  })

  it('does not reuse a media id Shopify no longer has', async () => {
    // Somebody deleted the image in the Shopify admin. Keeping the stale id would
    // make productSet fail on an id that does not resolve.
    const stale = image({ shopifyMediaId: 'gid://shopify/MediaImage/gone' })
    const { files } = await buildProductFiles(
      [stale],
      [{ id: 'gid://shopify/MediaImage/other' }],
      'Necklace 005',
      sign,
    )
    expect(files[0].mediaId).toBeNull()
    expect(files[0].originalSource).not.toBeNull()
  })

  it('carries each source photograph its OWN description as alt text', async () => {
    const images = [
      image({ imageVersionId: 'v1', intakeFileId: 'f1', description: 'The first piece.' }),
      image({ imageVersionId: 'v2', intakeFileId: 'f2', description: 'The second piece.' }),
      image({ imageVersionId: 'v3', intakeFileId: 'f3', description: null }),
    ]
    const { files, published } = await buildProductFiles(images, null, 'Necklace 005', sign)

    expect(files.map((f) => f.alt)).toEqual([
      'The first piece.',
      'The second piece.',
      'Necklace 005 — product photograph',
    ])
    expect(published.map((p) => p.altFallback)).toEqual([false, false, true])
  })

  it('does NOT position-repair a MIXED set — that is a version change, not a crash', async () => {
    // The operator swapped the second photograph from the generated version to
    // the original. `save_product_draft` replaces that row, so its media id is
    // gone while the first image keeps hers. Repairing by position here would
    // republish the very version they just rejected.
    const kept = image({ imageVersionId: 'v1', intakeFileId: 'f1', shopifyMediaId: 'gid://m/1' })
    const swapped = image({
      imageVersionId: 'v2-original',
      intakeFileId: 'f2',
      storageKey: 'originals/f2.png',
    })

    const { files } = await buildProductFiles(
      [kept, swapped],
      [{ id: 'gid://m/1' }, { id: 'gid://m/2' }],
      'Necklace 005',
      sign,
    )

    expect(files[0].mediaId).toBe('gid://m/1')
    expect(files[1].mediaId).toBeNull()
    expect(files[1].originalSource).toContain('originals/f2.png')
  })

  it('mints exactly one presigned URL per uploaded image, and none for reused ones', async () => {
    const signed: string[] = []
    const counting = async (key: string) => {
      signed.push(key)
      return `https://r2.example.com/${key}?sig=x`
    }

    await buildProductFiles(
      [
        image({ imageVersionId: 'v1', intakeFileId: 'f1', shopifyMediaId: 'gid://m/1' }),
        image({ imageVersionId: 'v2', intakeFileId: 'f2', storageKey: 'versions/f2/v1.png' }),
      ],
      [{ id: 'gid://m/1' }, { id: 'gid://m/2' }],
      'Necklace 005',
      counting,
    )

    expect(signed).toEqual(['versions/f2/v1.png'])
  })
})
