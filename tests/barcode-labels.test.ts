import { describe, expect, it, vi } from 'vitest'
import { barcodeSvg, qrSvg, parseLabelRequest, renderLabelDocument } from '@/lib/labels/print'
import { readLabelVariants, searchLabelVariants, verifyLabelCodes, type LabelVariant } from '@/lib/labels/catalogue'
import type { ShopifyClient } from '@/lib/shopify/client'

const variant: LabelVariant = { id: 'gid://shopify/ProductVariant/1', sku: 'NK1333-C-WHITE', barcode: 'NK1333-C-WHITE', title: 'White', inventoryQuantity: 12, product: { id: 'p1', title: 'Necklace 1333' } }
const form = (copies = '12') => { const f = new FormData(); f.set('symbology', 'code128'); f.set('width', '70'); f.set('height', '30'); f.set(`copies:${variant.id}`, copies); return f }
const clientFor = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as ShopifyClient
const page = (nodes: unknown[]) => ({ productVariants: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } })

describe('printable labels', () => {
  it('fits a compact QR and its four-module quiet zone on 40 × 25 mm pouch labels', () => {
    const f = form('1'); f.set('symbology', 'qr'); f.set('width', '40'); f.set('height', '25')
    const html = renderLabelDocument(parseLabelRequest(f), [variant])
    expect(html).toContain('padding:2mm')
    expect(html).toContain('40mm 25mm')
    expect(html).toContain('2D scanner or phone')
    expect(qrSvg(variant.barcode!, 40, 25)).toContain('width:14.5mm')
    expect(() => qrSvg('X'.repeat(64), 30, 25)).toThrow(/larger label/)
  })
  it('prints exactly the selected physical copies using the saved barcode', () => {
    const selection = parseLabelRequest(form())
    const html = renderLabelDocument(selection, [variant])
    expect(html.match(/<article /g)).toHaveLength(12)
    expect(html).toContain('@page{size:70mm 30mm;margin:0}')
    expect(html).toContain('NK1333-C-WHITE')
    expect(html).toContain('data:image/svg+xml,')
    expect(html).toContain('12 labels')
  })
  it('escapes product text and refuses missing barcodes', () => {
    const selection = parseLabelRequest(form('1'))
    expect(renderLabelDocument(selection, [{ ...variant, product: { ...variant.product, title: '<script>alert(1)</script>' } }])).not.toContain('<script>')
    expect(() => renderLabelDocument(selection, [{ ...variant, barcode: null }])).toThrow(/no saved/)
  })
  it.each(['', '-1', '1.5', '501', 'abc', '0'])('rejects invalid or empty copy selection %s', copies => {
    expect(() => parseLabelRequest(form(copies))).toThrow()
  })
  it('rejects duplicate IDs, oversized runs and unsuitable paper', () => {
    const duplicate = form(); duplicate.append(`copies:${variant.id}`, '1')
    expect(() => parseLabelRequest(duplicate)).toThrow()
    const oversized = form('500'); for (let i = 2; i <= 5; i++) oversized.set(`copies:gid://shopify/ProductVariant/${i}`, '500')
    expect(() => parseLabelRequest(oversized)).toThrow(/2,000/)
    const small = form(); small.set('height', '10')
    expect(() => parseLabelRequest(small)).toThrow(/height/)
  })
  it('preserves quiet zones and rejects barcodes too wide for the sticker', () => {
    expect(barcodeSvg(variant.barcode!, 66)).toContain('padding:0 2.54mm')
    expect(() => barcodeSvg(variant.barcode!, 26)).toThrow(/too narrow/)
    expect(() => barcodeSvg('^FNC1', 66)).toThrow(/cannot be printed/)
  })
})

describe('saved Shopify label data', () => {
  it('rejects a deleted variant and uses freshly read values', async () => {
    const graphql = vi.fn().mockResolvedValueOnce({ nodes: [null] }).mockResolvedValueOnce({ nodes: [{ ...variant, barcode: 'NEWCODE' }] })
    await expect(readLabelVariants(clientFor(graphql), [variant.id])).rejects.toThrow(/no longer exists/)
    expect((await readLabelVariants(clientFor(graphql), [variant.id]))[0].barcode).toBe('NEWCODE')
  })
  it('blocks ambiguous shared colour barcodes even within one product', async () => {
    const shared = { ...variant, barcode: 'NK1333' }
    const graphql = vi.fn().mockResolvedValue(page([shared, { ...shared, id: 'gid://shopify/ProductVariant/2' }]))
    await expect(verifyLabelCodes(clientFor(graphql), [shared])).rejects.toThrow(/another variant/)
  })
  it('does not print a code Shopify search cannot confirm yet', async () => {
    const graphql = vi.fn().mockResolvedValue(page([]))
    await expect(verifyLabelCodes(clientFor(graphql), [variant])).rejects.toThrow(/missing/)
  })
  it('finds all colour codes from a parent SKU while filtering prefix near-matches', async () => {
    const graphql = vi.fn().mockResolvedValue(page([variant, { ...variant, id: 'v2', sku: 'NK13330' }]))
    expect(await searchLabelVariants(clientFor(graphql), 'nk1333')).toEqual([variant])
  })
})
