import { describe, expect, it } from 'vitest'

import { scanCopy } from '@/lib/workflows/copy-rules-scan'
import { scanDuplicates } from '@/lib/workflows/duplicates-scan'

const APPROVED_BODY =
  'Premium 316L Stainless Steel – highly durable, rust-resistant and ready for everyday wear ' +
  'Water-resistant for daily wear — remove before swimming, bathing or physical activity ' +
  'Not fully soap-proof or chemical-proof – avoid harsh chemicals for longer life ' +
  'Finished in 18KT Gold Tone for a rich luxury look ' +
  'Advanced PVD Coating, not standard plating – long-lasting colour, anti-tarnish & scratch resistance ' +
  'Extra E-Coating Layer on top – added protection and shine'

describe('copy rules scan (D122)', () => {
  it('passes the owner-approved six bullets and the Loupe SEO pattern', () => {
    expect(
      scanCopy('rings-263', [
        ['description', APPROVED_BODY],
        ['SEO title', 'Wholesale 316L Stainless Steel Ring — 263 | Qimati'],
        ['SEO description', 'Wholesale 316L stainless steel ring with an 18kt gold-colour PVD finish. Design 263.'],
      ]),
    ).toEqual([])
  })

  it('flags the old boilerplate, bare 18kt gold and absolutes, once per rule per field', () => {
    const rules = scanCopy('necklace-784', [
      [
        'description',
        'Made with premium 316L Stainless Steel (Surgical Grade) – skin-friendly. Waterproof against sweat & moisture. 100% anti-tarnish, 18kt gold plated. Ensures long life.',
      ],
    ]).map((finding) => finding.rule)
    expect(rules).toEqual([
      'Absolute claim',
      'Bare 18kt gold',
      'Waterproof claim',
      'Skin-friendly / surgical grade',
      '"ensures" (performance guarantee)',
    ])
  })
})

describe('duplicate SKU and copied-handle scan (D122)', () => {
  it('groups one SKU across two products and spots -copy handles', () => {
    const a = { id: '1', handle: 'rings-221', title: 'Rings 221' }
    const b = { id: '2', handle: 'rings-222-adjustable', title: 'Rings 222 (Adjustable)' }
    const c = { id: '3', handle: 'rings-224set-copy', title: 'Rings 224' }
    const scan = scanDuplicates([
      { sku: 'RS221', product: a },
      { sku: 'rs221', product: b },
      { sku: 'RS221', product: b },
      { sku: 'RS224', product: c },
      { sku: '', product: c },
      { sku: 'X1', product: null },
    ])
    expect(scan.duplicateSkus).toEqual([{ sku: 'RS221', products: [a, b] }])
    expect(scan.copiedHandles).toEqual([c])
  })
})
