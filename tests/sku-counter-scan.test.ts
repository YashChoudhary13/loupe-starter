import { describe, expect, it } from 'vitest'

import {
  EXCLUDED_MALFORMED_SKUS,
  planSkuCounterSync,
  scanSkuVariants,
} from '@/lib/reconciliation/sku-counter-scan'

describe('live Shopify SKU counter scan', () => {
  it('ignores only the three confirmed catalogue typos before taking each maximum', () => {
    const result = scanSkuVariants([
      { sku: 'NK974', title: 'Necklace 974' },
      { sku: 'NK7801', title: 'Necklace 801' },
      { sku: 'NK975', title: 'Necklace 975' },
      { sku: 'BK3367', title: 'Bracelet Kada 337 (Small)' },
      { sku: 'BK362', title: 'Bracelet Kada 362' },
      { sku: 'AK0834', title: 'Anklets 084 (Single Piece)' },
      { sku: 'AK087', title: 'Anklets 087 (Single Piece)' },
    ])

    expect(EXCLUDED_MALFORMED_SKUS.size).toBe(3)
    expect(result.findings.get('NK')?.max).toBe(975)
    expect(result.findings.get('BK')?.max).toBe(362)
    expect(result.findings.get('AK')?.max).toBe(87)
    expect(result.excludedMalformed).toEqual([
      { sku: 'NK7801', title: 'Necklace 801', correctedSku: 'NK801' },
      {
        sku: 'BK3367',
        title: 'Bracelet Kada 337 (Small)',
        correctedSku: 'BK337',
      },
      {
        sku: 'AK0834',
        title: 'Anklets 084 (Single Piece)',
        correctedSku: 'AK084',
      },
    ])
  })

  it('still reports blank, unparseable, and unknown-prefix SKUs', () => {
    const result = scanSkuVariants([
      { sku: null, title: 'Blank' },
      { sku: 'NOT-A-SEQUENCE', title: 'Manual SKU' },
      { sku: 'ZZ042', title: 'Unknown category' },
    ])

    expect(result.scanned).toBe(3)
    expect(result.blank).toBe(1)
    expect(result.unparseable).toEqual([
      { sku: 'NOT-A-SEQUENCE', title: 'Manual SKU' },
    ])
    expect(result.findings.get('ZZ')).toMatchObject({ max: 42, count: 1 })
  })

  it('raises only counters Shopify has moved ahead and never reuses deleted numbers', () => {
    const scan = scanSkuVariants([
      { sku: 'NK981', title: 'Necklace 981' },
      { sku: 'ER450', title: 'Earrings 450' },
      { sku: 'RS210', title: 'Rings 210' },
    ])

    expect(
      planSkuCounterSync(
        [
          { prefix: 'NK', current: 980 },
          { prefix: 'ER', current: 450 },
          { prefix: 'RS', current: 221 },
          { prefix: 'AK', current: 87 },
        ],
        scan.findings,
      ),
    ).toEqual([
      { prefix: 'NK', from: 980, shopifyMax: 981, action: 'raise' },
      { prefix: 'ER', from: 450, shopifyMax: 450, action: 'already-current' },
      { prefix: 'RS', from: 221, shopifyMax: 210, action: 'counter-ahead' },
      { prefix: 'AK', from: 87, shopifyMax: null, action: 'absent-in-shopify' },
    ])
  })
})
