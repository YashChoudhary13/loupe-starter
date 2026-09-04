import { describe, expect, it } from 'vitest'

import {
  badgeFor,
  bodyMaterials,
  planMaterialFixes,
  type MaterialProductInput,
} from '@/lib/workflows/material-plan'

const PREFIXES = new Map([
  ['rings', 'RS'],
  ['necklace', 'NK'],
  ['anklets', 'AK'],
])

function product(overrides: Partial<MaterialProductInput>): MaterialProductInput {
  return {
    id: 'gid://shopify/Product/1',
    handle: 'rings-263',
    title: 'Rings 263',
    status: 'ACTIVE',
    tags: ['304', 'NEWEST', 'Rings'],
    bodyText: 'Premium 316L Stainless Steel – highly durable, rust-resistant and ready for everyday wear',
    createdAt: '2026-09-01T00:00:00Z',
    seoTitle: 'Wholesale 304 Stainless Steel Ring — 256 | Qimati',
    seoDescription: 'x',
    material: '304',
    ...overrides,
  }
}

describe('material planner (D122)', () => {
  it('reads the description material and the theme badge priority', () => {
    expect([...bodyMaterials('Premium 316L Stainless Steel')]).toEqual(['316L'])
    expect([...bodyMaterials('316 l steel and brass')].sort()).toEqual(['316L', 'Brass'])
    expect(badgeFor(['304', 'Brass', '316L'])).toBe('316L')
    expect(badgeFor(['Rings'])).toBeNull()
  })

  it('makes tag, metafield and SEO follow the description of an admin duplicate', () => {
    const plan = planMaterialFixes([product({})], PREFIXES)
    expect(plan.active).toBe(1)
    expect(plan.needsHuman).toEqual([])
    expect(plan.changes).toHaveLength(1)
    const change = plan.changes[0]
    expect(change.material).toBe('316L')
    expect(change.tags?.after).toEqual(['NEWEST', 'Rings', '316L'])
    expect(change.metafield).toEqual({ before: '304', after: '316L' })
    expect(change.seo?.after.title).toBe('Wholesale 316L Stainless Steel Ring — 263 | Qimati')
    expect(change.seo?.after.description).toContain('Design 263')
  })

  it('reports, never guesses, when the description names two materials or none', () => {
    const plan = planMaterialFixes(
      [
        product({ handle: 'necklace-843', bodyText: 'Premium 316L Stainless Steel … Premium 304 Stainless Steel' }),
        product({ handle: 'bag-1', bodyText: 'A canvas bag', tags: ['AS', 'NEWEST'], material: null }),
        product({ handle: 'np-2', bodyText: 'Premium something', tags: ['NP', '304'], material: null }),
      ],
      PREFIXES,
    )
    expect(plan.changes).toEqual([])
    expect(plan.needsHuman.map((row) => row.handle)).toEqual(['necklace-843', 'np-2'])
  })

  it('leaves consistent products, drafts and zz- test products alone', () => {
    const consistent = product({
      tags: ['316L', 'NEWEST', 'Rings'],
      material: '316L',
      seoTitle: 'Wholesale 316L Stainless Steel Ring — 263 | Qimati',
      seoDescription:
        'Wholesale 316L stainless steel ring with an 18kt gold-colour PVD finish. Design 263. Minimum order ₹1,000, prepaid. New designs twice a week from Jaipur.',
    })
    const plan = planMaterialFixes(
      [consistent, product({ status: 'DRAFT' }), product({ handle: 'zz-probe' })],
      PREFIXES,
    )
    expect(plan.active).toBe(1)
    expect(plan.changes).toEqual([])
    expect(plan.findings).toEqual([])
  })

  it('does not regenerate SEO written before the Loupe era', () => {
    const plan = planMaterialFixes(
      [product({ createdAt: '2026-08-20T00:00:00Z', tags: ['316L', 'NEWEST', 'Rings'], material: '316L' })],
      PREFIXES,
    )
    expect(plan.changes).toEqual([])
  })
})
