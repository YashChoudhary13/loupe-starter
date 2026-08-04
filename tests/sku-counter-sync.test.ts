import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { syncSkuCountersFromShopify } from '@/lib/reconciliation/sync-sku-counters'
import type { ShopifyClient } from '@/lib/shopify/client'

describe('manual Shopify SKU-counter reconciliation', () => {
  it('walks every page, raises only a known counter that Shopify moved ahead, and audits', async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        productVariants: {
          pageInfo: { hasNextPage: true, endCursor: 'page-2' },
          nodes: [
            { sku: 'NK981', product: { title: 'Necklace 981' } },
            { sku: 'ER450', product: { title: 'Earrings 450' } },
            { sku: 'NK7801', product: { title: 'Necklace 801' } },
          ],
        },
      })
      .mockResolvedValueOnce({
        productVariants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { sku: 'RS210', product: { title: 'Rings 210' } },
            { sku: 'ZZ042', product: { title: 'Unknown category' } },
            { sku: null, product: { title: 'Blank SKU' } },
            { sku: 'NOT-A-SEQUENCE', product: { title: 'Manual SKU' } },
          ],
        },
      })
    const inserts: unknown[] = []
    const rpc = vi.fn(async (name: string, input: { p_prefix: string; p_to: number }) => {
      expect(name).toBe('raise_sku_counter')
      expect(input).toEqual({ p_prefix: 'NK', p_to: 981 })
      return { data: 981, error: null }
    })
    const db = {
      from(table: string) {
        if (table === 'categories') {
          return {
            select: async () => ({
              data: [{ sku_prefix: 'NK' }, { sku_prefix: 'ER' }, { sku_prefix: 'RS' }],
              error: null,
            }),
          }
        }
        if (table === 'sku_counters') {
          return {
            select: async () => ({
              data: [
                { sku_prefix: 'NK', last_number: 980 },
                { sku_prefix: 'ER', last_number: 450 },
                { sku_prefix: 'RS', last_number: 221 },
              ],
              error: null,
            }),
          }
        }
        if (table === 'events') {
          return {
            insert: async (row: unknown) => {
              inserts.push(row)
              return { error: null }
            },
          }
        }
        throw new Error(`Unexpected table ${table}`)
      },
      rpc,
    }

    const result = await syncSkuCountersFromShopify(
      'operator@example.com',
      { graphql } as unknown as ShopifyClient,
      db as unknown as SupabaseClient,
    )

    expect(graphql).toHaveBeenNthCalledWith(1, expect.any(String), { cursor: null })
    expect(graphql).toHaveBeenNthCalledWith(2, expect.any(String), { cursor: 'page-2' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      variantsScanned: 7,
      raised: [{ prefix: 'NK', from: 980, to: 981 }],
      countersChecked: 3,
      blankSkus: 1,
      unparseableSkus: 1,
      excludedMalformedSkus: 1,
      unknownPrefixes: [{ prefix: 'ZZ', max: 42, count: 1 }],
    })
    expect(inserts).toEqual([
      expect.objectContaining({
        entity_type: 'system',
        event: 'reconciliation.sku_counters',
        actor: 'operator@example.com',
        detail: expect.objectContaining({
          variants_scanned: 7,
          raised: [{ prefix: 'NK', from: 980, to: 981 }],
        }),
      }),
    ])
  })
})
