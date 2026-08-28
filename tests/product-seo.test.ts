import { describe, expect, it } from 'vitest'

import { SEO_DESCRIPTION_MAX_LENGTH, buildSeo } from '@/lib/publish/seo'

describe('publish-time SEO fields', () => {
  it('writes the catalogue pattern for a steel product, with the earrings pair note', () => {
    expect(buildSeo({ skuPrefix: 'ER', skuNumber: 548, material: '304' })).toEqual({
      title: 'Wholesale 304 Stainless Steel Earrings — 548 | Qimati',
      description:
        'Wholesale 304 stainless steel earrings with an 18kt gold-colour PVD finish. Design 548. Sold as a pair. Minimum order ₹1,000, prepaid.',
    })
  })

  it('pads the design number like the SKU and adds the cadence line when it fits', () => {
    const seo = buildSeo({ skuPrefix: 'NK', skuNumber: 7, material: '316L' })
    expect(seo.title).toBe('Wholesale 316L Stainless Steel Necklace — 007 | Qimati')
    expect(seo.description).toBe(
      'Wholesale 316L stainless steel necklace with an 18kt gold-colour PVD finish. Design 007. Minimum order ₹1,000, prepaid. New designs twice a week from Jaipur.',
    )
    expect(seo.description.length).toBeLessThanOrEqual(SEO_DESCRIPTION_MAX_LENGTH)
  })

  it('describes brass as a gold-colour finish, never PVD, and anklets as sold singly', () => {
    expect(buildSeo({ skuPrefix: 'BK', skuNumber: 78, material: 'Brass' }).description).toContain(
      'Wholesale brass kada bracelet with a gold-colour finish. Design 078.',
    )
    expect(buildSeo({ skuPrefix: 'AK', skuNumber: 87, material: '304' }).description).toContain(
      'Design 087. Sold singly.',
    )
  })

  it('makes no finish or rust claim for a custom material, and none at all without one', () => {
    const custom = buildSeo({ skuPrefix: 'RS', skuNumber: 12, material: ' Sterling  Silver ' })
    expect(custom.title).toBe('Wholesale Sterling Silver Ring — 012 | Qimati')
    expect(custom.description).toBe(
      'Wholesale Sterling Silver ring. Design 012. Minimum order ₹1,000, prepaid. New designs twice a week from Jaipur.',
    )
    expect(custom.description).not.toContain('PVD')
    expect(buildSeo({ skuPrefix: 'RS', skuNumber: 12, material: null }).title).toBe(
      'Wholesale Ring — 012 | Qimati',
    )
  })

  it('falls back to the category name for a prefix it does not know', () => {
    expect(
      buildSeo({ skuPrefix: 'JB', skuNumber: 3, material: null, categoryName: 'Jewellery Box' })
        .title,
    ).toBe('Wholesale Jewellery Box — 003 | Qimati')
  })
})
