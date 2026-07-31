import { describe, expect, it } from 'vitest'

import {
  comparePublishedProduct,
  type ActualReconciliationProduct,
  type ExpectedReconciliationProduct,
} from '@/lib/reconciliation/compare'

const expected: ExpectedReconciliationProduct = {
  draftId: 'draft-1',
  shopifyProductId: 'gid://shopify/Product/1',
  handle: 'necklace-001',
  title: 'Necklace 001',
  productType: 'Jewellery',
  requiredTags: ['Necklace', 'NEWEST'],
  descriptionHtml: '<ul><li>Clean</li></ul>',
  material: '316L',
  variants: [{ sku: 'NK001', price: '100.00', weightG: 0, colour: null }],
  mediaIds: ['gid://shopify/MediaImage/1'],
  missingRecordedMedia: false,
}

const actual: ActualReconciliationProduct = {
  id: 'gid://shopify/Product/1',
  handle: 'necklace-001',
  title: 'Necklace 001',
  status: 'ACTIVE',
  productType: 'Jewellery',
  tags: ['Necklace', 'NEWEST'],
  descriptionHtml: '<ul>\n<li>Clean</li>\n</ul>',
  metafield: { value: '316L' },
  variants: {
    nodes: [
      {
        sku: 'NK001',
        price: '100.00',
        selectedOptions: [{ name: 'Title', value: 'Default Title' }],
        inventoryItem: { measurement: { weight: { value: 0, unit: 'GRAMS' } } },
      },
    ],
  },
  media: { nodes: [{ id: 'gid://shopify/MediaImage/1' }] },
}

describe('Shopify reconciliation comparison', () => {
  it('accepts the exact Loupe-owned catalogue state and Shopify HTML whitespace', () => {
    expect(comparePublishedProduct(expected, actual)).toEqual([])
  })

  it('reports a missing product as one clear issue', () => {
    expect(comparePublishedProduct(expected, null)).toEqual([
      expect.objectContaining({ code: 'product_missing', field: 'product' }),
    ])
  })

  it('requires category and NEWEST tags but permits unrelated merchandising tags', () => {
    expect(
      comparePublishedProduct(expected, { ...actual, tags: [...actual.tags, 'Campaign'] }),
    ).toEqual([])
    expect(comparePublishedProduct(expected, { ...actual, tags: ['Necklace'] })).toEqual([
      expect.objectContaining({
        code: 'required_tag_missing',
        field: 'tags',
        message: expect.stringContaining('NEWEST'),
      }),
    ])
  })

  it('reports identity, price, material and media drift independently', () => {
    const issues = comparePublishedProduct(expected, {
      ...actual,
      handle: 'changed',
      metafield: { value: 'Brass' },
      variants: {
        nodes: [{ ...actual.variants.nodes[0]!, price: '99.00' }],
      },
      media: { nodes: [{ id: 'gid://shopify/MediaImage/other' }] },
    })
    expect(issues.map((row) => row.field)).toEqual([
      'handle',
      'material',
      'variants.0.price',
      'media',
    ])
  })

  it('does not compare live stock, because sales legitimately change it', () => {
    const withUnrelatedInventoryField = {
      ...actual,
      variants: {
        nodes: [{ ...actual.variants.nodes[0]!, inventoryQuantity: -10 }],
      },
    } as unknown as ActualReconciliationProduct
    expect(comparePublishedProduct(expected, withUnrelatedInventoryField)).toEqual([])
  })
})
