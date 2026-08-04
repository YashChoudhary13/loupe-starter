import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { promotePublishedInShopify } from '@/lib/reconciliation/promote'
import type { ShopifyClient } from '@/lib/shopify/client'

function draftQuery(rows: readonly Record<string, unknown>[]) {
  const query = {
    select: vi.fn(() => query),
    in: vi.fn(() => query),
    not: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: rows, error: null })),
  }
  return query
}

describe('Shopify-backed draft reconciliation', () => {
  it('deletes a remotely missing draft and does not report a raced deletion as removed', async () => {
    const rows = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        reserved_sku: 'BK363',
        reserved_handle: 'bracelet-kada-363-small',
        shopify_product_id: 'gid://shopify/Product/363',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        reserved_sku: 'BK364',
        reserved_handle: 'bracelet-kada-364',
        shopify_product_id: 'gid://shopify/Product/364',
      },
    ]
    const query = draftQuery(rows)
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true, error: null })
      // A concurrent Save changed the id or took the publish lease after the
      // Shopify read. The fenced database function declines the stale delete.
      .mockResolvedValueOnce({ data: false, error: null })
    const db = {
      from: vi.fn(() => query),
      rpc,
    } as unknown as SupabaseClient
    const readProduct = vi.fn(async () => null)

    const result = await promotePublishedInShopify('test:reconcile', {
      db,
      shopify: {} as ShopifyClient,
      readProduct,
    })

    expect(query.in).toHaveBeenCalledWith('status', ['assembling', 'failed'])
    expect(readProduct).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenNthCalledWith(1, 'delete_shopify_missing_draft', {
      p_draft_id: rows[0]!.id,
      p_expected_shopify_product_id: rows[0]!.shopify_product_id,
      p_actor: 'test:reconcile',
    })
    expect(result).toEqual({
      checked: 2,
      promoted: [],
      deleted: [{ draftId: rows[0]!.id, sku: 'BK363' }],
      failures: [],
    })
  })

  it('keeps a failed database removal visible to the operator', async () => {
    const rows = [
      {
        id: '33333333-3333-3333-3333-333333333333',
        reserved_sku: 'RS229',
        reserved_handle: 'rings-229',
        shopify_product_id: 'gid://shopify/Product/229',
      },
    ]
    const query = draftQuery(rows)
    const db = {
      from: vi.fn(() => query),
      rpc: vi.fn(async () => ({ data: null, error: { message: 'delete refused' } })),
    } as unknown as SupabaseClient

    const result = await promotePublishedInShopify('test:reconcile', {
      db,
      shopify: {} as ShopifyClient,
      readProduct: async () => null,
    })

    expect(result.deleted).toEqual([])
    expect(result.failures).toEqual([{ draftId: rows[0]!.id, reason: 'delete refused' }])
  })
})
