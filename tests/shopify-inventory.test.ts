import { describe, expect, it } from 'vitest'

import { buildSetQuantitiesInput, variantLabel } from '@/lib/shopify/inventory'

describe('restock inventory input (D112)', () => {
  it('sets absolute available quantities at one location with a reference document', () => {
    const input = buildSetQuantitiesInput(
      'gid://shopify/Location/1',
      [{ inventoryItemId: 'gid://shopify/InventoryItem/9', quantity: 15 }],
      'loupe://restock/abc',
    )
    expect(input).toEqual({
      name: 'available',
      reason: 'received',
      ignoreCompareQuantity: true,
      referenceDocumentUri: 'loupe://restock/abc',
      quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/9', locationId: 'gid://shopify/Location/1', quantity: 15 }],
    })
  })

  it('refuses a negative or fractional quantity before Shopify sees it', () => {
    expect(() => buildSetQuantitiesInput('l', [{ inventoryItemId: 'i', quantity: -1 }], 'r')).toThrow(/whole number/)
    expect(() => buildSetQuantitiesInput('l', [{ inventoryItemId: 'i', quantity: 1.5 }], 'r')).toThrow(/whole number/)
  })

  it('labels variants by their option values and the default variant as Default', () => {
    expect(variantLabel([{ name: 'Color', value: 'Gold' }])).toBe('Gold')
    expect(variantLabel([{ name: 'Title', value: 'Default Title' }])).toBe('Default')
  })
})
