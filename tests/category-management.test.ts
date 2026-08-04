import { describe, expect, it } from 'vitest'

import {
  suggestedSkuPrefix,
  suggestedTitleBase,
  validateCategoryInput,
} from '../src/lib/categories/validation'

describe('new category suggestions', () => {
  it('suggests the Waist Chains naming rule without allocating a number', () => {
    expect(suggestedSkuPrefix('Waist Chains')).toBe('WC')
    expect(suggestedTitleBase('Waist Chains')).toBe('Waist Chain')
  })

  it('uses initials for multi-word categories and two letters for one word', () => {
    expect(suggestedSkuPrefix('Jewellery Storage Bags')).toBe('JSB')
    expect(suggestedSkuPrefix('Brooches')).toBe('BR')
  })
})

describe('new category validation', () => {
  it('normalises operator input into the database title pattern', () => {
    expect(
      validateCategoryInput({
        name: '  Waist   Chains ',
        skuPrefix: 'wc',
        titleBase: ' Waist Chain ',
        shopifyTag: ' Waist Chain ',
        shopifyTaxonomyCategoryId: 'gid://shopify/TaxonomyCategory/aa-6-2',
      }),
    ).toEqual({
      ok: true,
      value: {
        name: 'Waist Chains',
        skuPrefix: 'WC',
        titlePattern: 'Waist Chain {n}',
        shopifyTag: 'Waist Chain',
        shopifyTaxonomyCategoryId: 'gid://shopify/TaxonomyCategory/aa-6-2',
      },
    })
  })

  it('requires explicit SKU letters, tag, and a Shopify taxonomy result', () => {
    const base = {
      name: 'Waist Chains',
      skuPrefix: 'WC',
      titleBase: 'Waist Chain',
      shopifyTag: 'Waist Chain',
      shopifyTaxonomyCategoryId: 'gid://shopify/TaxonomyCategory/aa-6-2',
    }

    expect(validateCategoryInput({ ...base, skuPrefix: 'W1' })).toMatchObject({ ok: false })
    expect(validateCategoryInput({ ...base, shopifyTag: '' })).toMatchObject({ ok: false })
    expect(validateCategoryInput({ ...base, shopifyTaxonomyCategoryId: '' })).toMatchObject({
      ok: false,
    })
  })
})
