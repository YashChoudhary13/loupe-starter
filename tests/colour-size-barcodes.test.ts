import { describe, expect, it, vi } from 'vitest'
import { variantSkus, parentSku } from '@/lib/publish/variant-sku'
import { buildInput, type ProductSetArgs } from '@/lib/shopify/product-set'
import { comparePublishedProduct, type ExpectedReconciliationProduct } from '@/lib/reconciliation/compare'
import { applyProductCodes, planProductCodes } from '@/lib/labels/prepare-codes'
import type { ShopifyClient } from '@/lib/shopify/client'

const pairs = [{ value: 'Gold', sizeValue: '7', stock: 12 }, { value: 'Gold', sizeValue: '8', stock: 15 }, { value: 'Silver', sizeValue: '8', stock: 20 }]
const codes = ['RS004-C-GOLD-S-7', 'RS004-C-GOLD-S-8', 'RS004-C-SILVER-S-8']
const args: ProductSetArgs = { handle: 'rings-004', title: 'Rings 004', productType: 'Jewellery', tags: [], descriptionHtml: '', material: null, categoryId: 'gid://shopify/TaxonomyCategory/test', optionName: 'Color', secondaryOptionName: 'Size', variants: pairs.map((v, i) => ({ id: `v${i}`, sku: codes[i], barcode: codes[i], price: '120.00', weightG: 20, stock: v.stock, locationId: 'l1', optionValue: v.value, sizeValue: v.sizeValue, linkedMetafieldValue: v.value === 'Gold' ? 'gold-metaobject' : 'silver-metaobject' })) }

describe('colour with its own sizes', () => {
  it('creates exactly the selected pairs, keeping their codes across reorder', () => {
    expect(variantSkus('RS004', 'colour_size', pairs, 'variant-v1')).toEqual(codes)
    expect(variantSkus('RS004', 'colour_size', [...pairs].reverse(), 'variant-v1')).toEqual([...codes].reverse())
    expect(codes.map(parentSku)).toEqual(['RS004', 'RS004', 'RS004'])
  })
  it('refuses missing sizes, duplicate normalized pairs and legacy identities', () => {
    expect(() => variantSkus('RS004', 'colour_size', [{ value: 'Gold' }], 'variant-v1')).toThrow(/both/)
    expect(() => variantSkus('RS004', 'colour_size', [...pairs, { value: ' gold ', sizeValue: '7' }], 'variant-v1')).toThrow(/same barcode/)
    expect(() => variantSkus('RS004', 'colour_size', pairs, 'legacy')).toThrow(/new draft/)
  })
  it('sends two options with deduplicated values and preserves exact variant IDs/stock', () => {
    const input = buildInput(args)
    expect(input.productOptions).toEqual([{ name: 'Color', linkedMetafield: { namespace: 'shopify', key: 'color-pattern', values: ['gold-metaobject', 'silver-metaobject'] } }, { name: 'Size', values: [{ name: '7' }, { name: '8' }] }])
    expect(input.variants).toHaveLength(3)
    const rows = input.variants as { id: string; sku: string; barcode: string; optionValues: unknown[]; inventoryQuantities: { quantity: number }[] }[]
    expect(rows.map(v => [v.id, v.sku, v.barcode, v.inventoryQuantities[0].quantity])).toEqual(pairs.map((v,i) => [`v${i}`,codes[i],codes[i],v.stock]))
    expect(rows[2].optionValues).toEqual([{ optionName: 'Color', linkedMetafieldValue: 'silver-metaobject' }, { optionName: 'Size', name: '8' }])
  })
  it('reconciles both dimensions even after rows and option positions are reordered', () => {
    const expected: ExpectedReconciliationProduct = { draftId: 'd', shopifyProductId: 'p', handle: 'rings-004', title: 'Rings 004', variants: pairs.map((v,i) => ({ sku: codes[i], barcode: codes[i], optionName: 'Color', optionValue: v.value, sizeValue: v.sizeValue })) }
    const actual = { id: 'p', handle: expected.handle, title: expected.title, variants: { nodes: [...expected.variants].reverse().map(v => ({ sku: v.sku, barcode: v.barcode, selectedOptions: [{ name: 'Size', value: v.sizeValue! }, { name: 'Color', value: v.optionValue! }] })) } }
    expect(comparePublishedProduct(expected, actual)).toEqual([])
    actual.variants.nodes[0].selectedOptions[0].value = '7'
    expect(comparePublishedProduct(expected, actual).some(i => i.field.endsWith('.size'))).toBe(true)
  })
})

describe('existing catalogue preparation', () => {
  const id = 'gid://shopify/Product/10'
  const saved = pairs.map((v,i) => ({ id: `gid://shopify/ProductVariant/${i+1}`, sku: 'RS004', barcode: null, title: `${v.value} / ${v.sizeValue}`, selectedOptions: [{ name: 'Color', value: v.value }, { name: 'Size', value: v.sizeValue }] }))
  it('reads complete saved options and proposes only SKU/barcode changes for each exact ID', async () => {
    const graphql = vi.fn().mockImplementation(async (query: string) => query.includes('LoupePrepareCodes') ? { product: { id, title: 'Rings 004', variants: { nodes: saved, pageInfo: { hasNextPage: false } } } } : query.includes('LoupeLabelSearch') ? { productVariants: { nodes: saved.map(v => ({...v, product:{id}})), pageInfo: { hasNextPage: false } } } : { productVariants: { nodes: [], pageInfo: { hasNextPage: false } } })
    const client = { graphql } as unknown as ShopifyClient
    const plan = await planProductCodes(client,id)
    expect(plan.rows.map(v=>v.sku)).toEqual(codes)
    graphql.mockResolvedValue({ productVariantsBulkUpdate: { userErrors: [], productVariants: plan.rows } })
    await applyProductCodes(client,plan)
    expect(graphql.mock.lastCall?.[1]).toEqual({ productId:id, variants: plan.rows.map(row=>({id:row.id,barcode:row.barcode,inventoryItem:{sku:row.sku}})) })
    expect(graphql.mock.lastCall?.[0]).toContain('allowPartialUpdates: false')
  })
  it('derives sizes from a "Ring size" option and numbered choices from a small-integer option, instead of variant-id fallbacks', async () => {
    const product = (title: string, parent: string, option: string, values: string[]) => {
      const nodes = values.map((value, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: parent, barcode: null, title: value, selectedOptions: [{ name: option, value }] }))
      const graphql = vi.fn().mockImplementation(async (query: string) => query.includes('LoupePrepareCodes') ? { product: { id, title, variants: { nodes, pageInfo: { hasNextPage: false } } } }
        : query.includes('LoupeLabelSearch') ? { productVariants: { nodes: nodes.map(v => ({ ...v, product: { id } })), pageInfo: { hasNextPage: false, endCursor: null } } }
        : { productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
      return { graphql } as unknown as ShopifyClient
    }
    expect((await planProductCodes(product('Rings 242 (4 Rings Set)', 'RS242', 'Ring size', ['5', '6', '7', '8']), id)).rows.map(r => r.sku)).toEqual(['RS242-S-5', 'RS242-S-6', 'RS242-S-7', 'RS242-S-8'])
    expect((await planProductCodes(product('Brooch 038', 'BR038', 'Designs', ['1', '2', '3']), id)).rows.map(r => r.sku)).toEqual(['BR038-N-1', 'BR038-N-2', 'BR038-N-3'])
    const fallback = (await planProductCodes(product('Necklace 088', 'NK088', 'type', ['Star', 'Heart']), id)).rows.map(r => r.sku)
    expect(fallback).toEqual(['NK088-N-1', 'NK088-N-2'])
  })
  it('blocks truncated products before proposing any change', async () => {
    const client = {graphql:vi.fn().mockResolvedValue({product:{id,title:'Rings',variants:{nodes:saved,pageInfo:{hasNextPage:true}}}})} as unknown as ShopifyClient
    await expect(planProductCodes(client,id)).rejects.toThrow(/1–250/)
  })
})
