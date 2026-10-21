import { describe, expect, it } from 'vitest'
import { renderLabelTspl, tsplText } from '@/lib/labels/tspl'
import type { LabelVariant } from '@/lib/labels/catalogue'

const variant = (id: string, barcode: string | null, title = 'Default Title', product = 'Necklace 1333'): LabelVariant => ({ id, sku: barcode, barcode, title, inventoryQuantity: 3, product: { id: 'gid://shopify/Product/1', title: product } })

describe('labels as TSPL for the TSC TE244', () => {
  it('writes one block per variant with its copies on PRINT, QR on the left, product, option and code on the right, inside 3 mm margins', () => {
    const { tspl, labels } = renderLabelTspl([{ id: 'v1', copies: 12 }, { id: 'v2', copies: 1 }], [variant('v1', 'NK1333-C-WHITE', 'White'), variant('v2', 'NK1333-C-GOLD', 'Gold')])
    expect(tspl.startsWith('SIZE 38 mm,25 mm\nGAP 3 mm,0 mm\n')).toBe(true)
    expect(tspl).toContain('QRCODE 24,56,M,4,A,0,"NK1333-C-WHITE"')
    expect(tspl).toContain('TEXT 136,56,"1",0,1,1,"NECKLACE 1333"')
    expect(tspl).toContain('TEXT 136,78,"2",0,1,1,"White"')
    expect(tspl).toContain('TEXT 136,112,"1",0,1,1,"NK1333-C-WHITE"')
    expect(tspl.match(/^PRINT 1,(\d+)$/gm)).toEqual(['PRINT 1,12', 'PRINT 1,1'])
    expect(labels).toBe(13)
    for (const line of tspl.split('\n').filter(l => l.startsWith('TEXT') || l.startsWith('QRCODE'))) {
      const [x, y] = line.split(' ')[1].split(',').map(Number)
      expect(x).toBeGreaterThanOrEqual(24); expect(y).toBeGreaterThanOrEqual(24); expect(y).toBeLessThanOrEqual(176 - 24)
    }
  })
  it('prints the code as large as the right column allows and says QIMATI once on a single-option product', () => {
    const one = renderLabelTspl([{ id: 'v1', copies: 1 }], [variant('v1', 'RS429')]).tspl
    expect(one).toContain('TEXT 136,112,"3",0,1,1,"RS429"')
    expect(one.match(/QIMATI/g)).toHaveLength(1)
    expect(renderLabelTspl([{ id: 'v1', copies: 1 }], [variant('v1', 'NK1333-C-WH')]).tspl).toContain('TEXT 136,112,"2",0,1,1,"NK1333-C-WH"')
    const long = renderLabelTspl([{ id: 'v1', copies: 1 }], [variant('v1', 'ABCDEFGHIJKLMNOPQRSTUVWX')]).tspl
    expect(long).toContain('TEXT 136,112,"1",0,1,1,"ABCDEFGHIJKLMNOPQR"'); expect(long).toContain('TEXT 136,126,"1",0,1,1,"STUVWX"')
  })
  it('skips zero copies, refuses a variant without a barcode, and never a quote inside a TSPL string', () => {
    expect(renderLabelTspl([{ id: 'v1', copies: 0 }, { id: 'v2', copies: 2 }], [variant('v1', 'A1'), variant('v2', 'B2')]).labels).toBe(2)
    expect(() => renderLabelTspl([{ id: 'v1', copies: 1 }], [variant('v1', null)])).toThrow(/no saved Shopify barcode/)
    expect(tsplText('Gold "7" \\ Rosé', 20)).toBe('Gold 7 Ros')
    expect(renderLabelTspl([{ id: 'v1', copies: 1 }], [variant('v1', 'RS004-S-7', 'Size "7"')]).tspl).toContain('"Size 7"')
  })
  it('caps copies at 500 a variant, like the form', () => {
    expect(renderLabelTspl([{ id: 'v1', copies: 900 }], [variant('v1', 'A1')]).labels).toBe(500)
  })
})
