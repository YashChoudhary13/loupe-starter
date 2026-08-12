/**
 * Reconciliation compares structure, not editorial content (D90).
 *
 * The split these tests defend is by OWNERSHIP. Loupe hands a product to Shopify
 * and the business finishes the listing there before launch — correcting the
 * material bullet, adjusting price, appending "(ball back)" to a title, swapping
 * photographs. Diffing those reported the business doing its job: the first run
 * with real data produced 45 issues across 23 of 53 products, all deliberate
 * edits, and would have reproduced them every morning.
 *
 * What Loupe still owns — existence, handle, SKU, variant structure — is checked
 * as strictly as before.
 */
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
  variants: [{ sku: 'NK001', optionName: null, optionValue: null }],
}

const actual: ActualReconciliationProduct = {
  id: 'gid://shopify/Product/1',
  handle: 'necklace-001',
  title: 'Necklace 001',
  variants: {
    nodes: [{ sku: 'NK001', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }],
  },
}

/** Extra Shopify fields the query no longer asks for, to prove nothing reads them. */
const withNoise = (overrides: Record<string, unknown>) =>
  ({ ...actual, ...overrides }) as unknown as ActualReconciliationProduct

describe('what reconciliation still checks', () => {
  it('accepts a product that matches on identity and structure', () => {
    expect(comparePublishedProduct(expected, actual)).toEqual([])
  })

  it('reports a product deleted in Shopify, and says the SKU number is spent', () => {
    expect(comparePublishedProduct(expected, null)).toEqual([
      expect.objectContaining({
        code: 'product_missing',
        field: 'product',
        message: expect.stringContaining('NK001'),
      }),
    ])
  })

  it('reports a draft published in Loupe with no recorded Shopify product id', () => {
    expect(comparePublishedProduct({ ...expected, shopifyProductId: null }, null)).toEqual([
      expect.objectContaining({ code: 'local_product_id_missing' }),
    ])
  })

  it('reports a changed handle, because the next save would create a second product', () => {
    // The handle is productSet's idempotency key (hard rule 2). Losing it turns
    // a retry into a duplicate listing carrying a duplicate SKU.
    expect(comparePublishedProduct(expected, { ...actual, handle: 'necklace-001-copy' })).toEqual([
      expect.objectContaining({ code: 'field_mismatch', field: 'handle' }),
    ])
  })

  it('reports a SKU that is no longer the one Loupe reserved', () => {
    // The AK089 case: an anklet listing repurposed into "Rings 229" in admin. The
    // title is the business's to change; the anklet SKU underneath it is not.
    const issues = comparePublishedProduct(expected, {
      ...actual,
      title: 'Rings 229',
      variants: { nodes: [{ ...actual.variants.nodes[0]!, sku: 'RS229' }] },
    })
    expect(issues).toEqual([
      expect.objectContaining({
        field: 'variants.0.sku',
        expected: 'NK001',
        actual: 'RS229',
      }),
    ])
  })

  it('reports a colour added or removed in Shopify', () => {
    const twoColours: ExpectedReconciliationProduct = {
      ...expected,
      variants: [
        { sku: 'NK001', optionName: 'Color', optionValue: 'Gold' },
        { sku: 'NK001', optionName: 'Color', optionValue: 'Silver' },
      ],
    }
    const oneColour = {
      ...actual,
      variants: {
        nodes: [{ sku: 'NK001', selectedOptions: [{ name: 'Color', value: 'Gold' }] }],
      },
    }

    expect(comparePublishedProduct(twoColours, oneColour)).toEqual([
      expect.objectContaining({
        code: 'variant_count_mismatch',
        expected: 2,
        actual: 1,
      }),
    ])
  })

  it('reports a colour renamed in Shopify', () => {
    const gold: ExpectedReconciliationProduct = {
      ...expected,
      variants: [{ sku: 'NK001', optionName: 'Color', optionValue: 'Gold' }],
    }
    expect(
      comparePublishedProduct(gold, {
        ...actual,
        variants: {
          nodes: [{ sku: 'NK001', selectedOptions: [{ name: 'Color', value: 'Rose Gold' }] }],
        },
      }),
    ).toEqual([expect.objectContaining({ field: 'variants.0.option' })])
  })

  it('does not call a spelling convention drift — Multi Colour IS Multicolor', () => {
    const multi: ExpectedReconciliationProduct = {
      ...expected,
      variants: [{ sku: 'NK001', optionName: 'Color', optionValue: 'Multi Colour' }],
    }
    expect(
      comparePublishedProduct(multi, {
        ...actual,
        variants: {
          nodes: [{ sku: 'NK001', selectedOptions: [{ name: 'Color', value: 'Multicolor' }] }],
        },
      }),
    ).toEqual([])
  })

  it('accepts Number and Size options unchanged', () => {
    for (const [name, value] of [
      ['Number', '17'],
      ['Size', '7.5'],
    ] as const) {
      expect(
        comparePublishedProduct(
          { ...expected, variants: [{ sku: 'NK001', optionName: name, optionValue: value }] },
          { ...actual, variants: { nodes: [{ sku: 'NK001', selectedOptions: [{ name, value }] }] } },
        ),
      ).toEqual([])
    }
  })
})

describe('what reconciliation deliberately ignores', () => {
  it('ignores a Shopify DRAFT status — that is the normal state before launch', () => {
    // Qimati drafts everything and publishes together on launch day. Demanding
    // ACTIVE would have marked the entire catalogue as drift.
    expect(comparePublishedProduct(expected, withNoise({ status: 'DRAFT' }))).toEqual([])
  })

  it('ignores a title edited in admin', () => {
    expect(
      comparePublishedProduct(expected, { ...actual, title: 'Necklace 001 (ball back)' }),
    ).toEqual([])
  })

  it('ignores description, material, product type and tag edits', () => {
    expect(
      comparePublishedProduct(
        expected,
        withNoise({
          descriptionHtml: '<ul><li>Made with premium 304 Stainless Steel</li></ul>',
          metafield: { value: '304' },
          productType: 'Jewelery',
          tags: ['Rings'],
        }),
      ),
    ).toEqual([])
  })

  it('ignores price and weight, which the business sets before launch', () => {
    expect(
      comparePublishedProduct(
        expected,
        withNoise({
          variants: {
            nodes: [
              {
                ...actual.variants.nodes[0]!,
                price: '85.00',
                inventoryItem: { measurement: { weight: { value: 12, unit: 'GRAMS' } } },
              },
            ],
          },
        }),
      ),
    ).toEqual([])
  })

  it('ignores media, and no longer demands a recorded media id', () => {
    // 13 of the original 45 were media bookkeeping. Nothing an operator can act
    // on, and not Shopify drift.
    expect(
      comparePublishedProduct(
        expected,
        withNoise({ media: { nodes: [{ id: 'gid://shopify/MediaImage/other' }] } }),
      ),
    ).toEqual([])
  })

  it('ignores live stock, because every sale changes it', () => {
    expect(
      comparePublishedProduct(
        expected,
        withNoise({
          variants: { nodes: [{ ...actual.variants.nodes[0]!, inventoryQuantity: -10 }] },
        }),
      ),
    ).toEqual([])
  })
})
