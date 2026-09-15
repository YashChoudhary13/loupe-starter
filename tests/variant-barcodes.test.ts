import { describe, expect, it, vi } from 'vitest'
import { parentSku, variantSku, variantSkus } from '@/lib/publish/variant-sku'
import { malformedSkuCorrection, parseSku } from '@/lib/publish/identity'
import { classifyHandleOwnership } from '@/lib/publish/handle-ownership'
import { buildInput } from '@/lib/shopify/product-set'
import { assertVariantCodesAvailable, findCodeMatches } from '@/lib/shopify/barcode-lookup'
import { readProductStockBySku } from '@/lib/shopify/inventory'
import { comparePublishedProduct, type ExpectedReconciliationProduct } from '@/lib/reconciliation/compare'
import type { ShopifyClient } from '@/lib/shopify/client'

const clientFor = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as ShopifyClient
const page = (nodes: unknown[], next: string | null = null) => ({ productVariants: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } })

describe('variant identities', () => {
  it('gives colours distinct repeatable codes and preserves them across reorder and canonical spelling', () => {
    expect(variantSkus('NK1333', 'colour', ['White', 'Green'], 'variant-v1')).toEqual(['NK1333-C-WHITE', 'NK1333-C-GREEN'])
    expect(variantSkus('NK1333', 'colour', ['Green', 'White'], 'variant-v1')).toEqual(['NK1333-C-GREEN', 'NK1333-C-WHITE'])
    expect(variantSku('NK1333', 'colour', 'Multi Colour', 'variant-v1')).toBe(variantSku('NK1333', 'colour', 'Multicolor', 'variant-v1'))
    expect(variantSku('RS004', 'size', '7', 'variant-v1')).toBe('RS004-S-7')
    expect(variantSku('RS004', 'number', '7', 'variant-v1')).toBe('RS004-N-7')
    expect(variantSku('ER004', 'none', null, 'variant-v1')).toBe('ER004')
  })
  it('keeps existing drafts on their old code scheme', () => {
    expect(variantSkus('NK1333', 'colour', ['White', 'Green'], 'legacy')).toEqual(['NK1333', 'NK1333'])
  })
  it('blocks normalization collisions and unencodable names', () => {
    expect(() => variantSkus('RS004', 'size', ['4.5', '4-5'], 'variant-v1')).toThrow(/same barcode/)
    expect(() => variantSkus('NK004', 'colour', ['Rose Gold', 'RoseGold'], 'variant-v1')).toThrow(/same barcode/)
    expect(() => variantSku('RS004', 'size', '💎', 'variant-v1')).toThrow(/option name/)
  })
  it('keeps sequence consumers on the parent number and preserves typo exclusions', () => {
    expect(parseSku('NK1333-C-WHITE')).toEqual({ prefix: 'NK', number: 1333 })
    expect(parentSku('NK1333-RANDOM')).toBeNull()
    expect(parentSku('NK1333-C-WHITE')).toBe('NK1333')
    expect(malformedSkuCorrection('NK7801-C-WHITE')).toBe('NK801')
  })
  it('recovers an interrupted publish only when the exact variant set matches', () => {
    const input = { handle: 'necklace-1333', reservedSku: 'NK1333', expectedVariantSkus: ['NK1333-C-WHITE', 'NK1333-C-GREEN'], recordedProductId: null, draftCreatedAt: '2026-09-14T00:00:00Z' }
    const product = { id: 'p1', title: 'Necklace 1333', createdAt: '2026-09-15T00:00:00Z', variants: { nodes: input.expectedVariantSkus.map(sku => ({ id: sku, sku, price: '1.00', selectedOptions: [], inventoryQuantity: 12, inventoryItem: null })) } }
    expect(classifyHandleOwnership(input, product).kind).toBe('adopt')
    expect(classifyHandleOwnership(input, { ...product, variants: { nodes: product.variants.nodes.slice(0, 1) } }).kind).toBe('foreign')
    expect(classifyHandleOwnership(input, { ...product, createdAt: '2026-09-13T00:00:00Z' }).kind).toBe('foreign')
  })
  it('writes SKU and barcode together but leaves an omitted legacy barcode untouched', () => {
    const input = buildInput({ handle: 'rings-004', title: 'Rings 004', descriptionHtml: '', productType: 'Jewellery', tags: [], material: null, optionName: 'Size', variants: [
      { sku: 'RS004-S-7', barcode: 'RS004-S-7', optionValue: '7', price: '50.00', weightG: 0, stock: 12, locationId: 'loc' },
      { sku: 'RS004', optionValue: '8', price: '50.00', weightG: 0, stock: 60, locationId: 'loc' },
    ] })
    expect(input.variants).toMatchObject([{ sku: 'RS004-S-7', barcode: 'RS004-S-7', inventoryItem: { sku: 'RS004-S-7' } }, { sku: 'RS004' }])
    expect((input.variants as Record<string, unknown>[])[1]).not.toHaveProperty('barcode')
  })
})

describe('Shopify code consumers', () => {
  it('checks every search page and ignores inexact search matches', async () => {
    const graphql = vi.fn().mockResolvedValueOnce(page([{ id: 'unrelated', sku: 'NK1333-C-WHITE-OTHER', barcode: null, product: { id: 'p2' } }], 'next')).mockResolvedValueOnce(page([{ id: 'v1', sku: null, barcode: 'NK1333-C-WHITE', product: { id: 'p1' } }]))
    expect(await findCodeMatches(clientFor(graphql), 'NK1333-C-WHITE')).toHaveLength(1)
    expect(graphql.mock.calls[1][1].after).toBe('next')
  })
  it('refuses a cross-product barcode collision before a publish', async () => {
    const graphql = vi.fn().mockResolvedValue(page([{ id: 'v1', sku: 'OTHER', barcode: 'NK1333-C-WHITE', product: { id: 'p1' } }]))
    await expect(assertVariantCodesAvailable(clientFor(graphql), ['NK1333-C-WHITE'], null)).rejects.toThrow(/another Shopify product/)
    await expect(assertVariantCodesAvailable(clientFor(graphql), ['NK1333-C-WHITE'], 'p1')).resolves.toBeUndefined()
  })
  it('restocks the entire paginated family when given one colour, excluding neighbouring product numbers', async () => {
    const node = (id: string, sku: string, option: string) => ({ id, sku, inventoryQuantity: 12, inventoryItem: { id: `i${id}` }, selectedOptions: [{ name: 'Color', value: option }], product: { id: 'p1', title: 'Necklace 1333', handle: 'necklace-1333', status: 'ACTIVE' } })
    const graphql = vi.fn().mockResolvedValueOnce(page([node('v1', 'NK1333-C-WHITE', 'White'), node('v3', 'NK13330', 'Gold')], 'next')).mockResolvedValueOnce(page([node('v2', 'NK1333-C-GREEN', 'Green')]))
    const stock = await readProductStockBySku(clientFor(graphql), 'NK1333-C-WHITE')
    expect(stock[0].variants.map(v => v.variantId)).toEqual(['v1', 'v2'])
    expect(graphql.mock.calls[0][1].query).toContain('sku:NK1333-*')
  })
  it('reports barcode drift but accepts a Shopify variant reorder', () => {
    const expected: ExpectedReconciliationProduct = { draftId: 'd1', shopifyProductId: 'p1', handle: 'necklace-1333', title: 'Necklace 1333', variants: ['White', 'Green'].map(value => ({ sku: `NK1333-C-${value.toUpperCase()}`, barcode: `NK1333-C-${value.toUpperCase()}`, optionName: 'Color', optionValue: value })) }
    const nodes = [...expected.variants].reverse().map(v => ({ sku: v.sku, barcode: v.barcode, selectedOptions: [{ name: 'Color', value: v.optionValue! }] }))
    const actual = { id: 'p1', handle: expected.handle, title: expected.title, variants: { nodes } }
    expect(comparePublishedProduct(expected, actual)).toEqual([])
    nodes[0].barcode = 'WRONG'
    expect(comparePublishedProduct(expected, actual).map(i => i.field)).toEqual(['variants.1.barcode'])
  })
})
