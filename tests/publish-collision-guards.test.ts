/**
 * The two guards that keep Loupe out of the way of hand-made Shopify products.
 *
 * Qimati lists products directly in Shopify admin, often, without the console.
 * On 2026-08-08 `necklace-1007` was created by hand at 08:01:39; the console
 * draft at 08:42:42 was issued `NK1007` from a counter that still said 1006, and
 * `productSet` — addressed by handle — collided with it. Shopify happened to
 * refuse the write because the manual product carried a linked Color option.
 * That refusal is the only reason it survived.
 *
 *   shopify-numbering   steps the counter past occupied numbers, so the
 *                       collision rarely happens.
 *   handle-ownership    refuses to write over a product Loupe did not create,
 *                       so when it does happen nothing is destroyed.
 *
 * Both are needed. Prevention that depends on a lookup a moment earlier cannot
 * cover somebody creating a product in the seconds in between.
 */
import { describe, expect, it, vi } from 'vitest'

import { classifyHandleOwnership, assertHandleIsWritable } from '@/lib/publish/handle-ownership'
import {
  MAX_NUMBER_PROBES,
  clearCounterOfShopifyNumbers,
  findFreeNumber,
} from '@/lib/publish/shopify-numbering'
import type { ShopifyClient } from '@/lib/shopify/client'

const NECKLACES = {
  prefix: 'NK',
  titlePattern: 'Necklace {n}',
  titleSuffix: null,
  counterLastNumber: 1006,
}

/** `taken` lists numbers Shopify holds, each by sku, by handle, or both. */
function probeClient(taken: Record<number, 'sku' | 'handle' | 'both'>) {
  const graphql = vi.fn(async (_query: string, variables?: Record<string, unknown>) => {
    const sku = String(variables?.sku ?? '')
    const handle = String(variables?.handle ?? '')
    const number = Number(sku.replace(/\D/gu, '')) || Number(handle.replace(/\D/gu, ''))
    const how = taken[number]
    return {
      variants: { nodes: how === 'sku' || how === 'both' ? [{ id: 'gid://v/1' }] : [] },
      product: how === 'handle' || how === 'both' ? { id: 'gid://p/1' } : null,
    }
  })
  return { graphql, client: { graphql } as unknown as ShopifyClient }
}

describe('stepping the counter past hand-made numbers', () => {
  it('takes the next number and writes nothing when Shopify is not ahead', async () => {
    const { client, graphql } = probeClient({})
    const raise = vi.fn()

    const result = await clearCounterOfShopifyNumbers(client, NECKLACES, raise)

    expect(result).toMatchObject({ nextFree: 1007, raisedTo: null, probes: 1 })
    // One round trip and no counter write on the ordinary path — this runs on
    // every publish.
    expect(graphql).toHaveBeenCalledTimes(1)
    expect(raise).not.toHaveBeenCalled()
  })

  it('steps over the real NK1007 case and leaves the counter ready to issue 1008', async () => {
    const { client } = probeClient({ 1007: 'both' })
    const raise = vi.fn()

    const result = await clearCounterOfShopifyNumbers(client, NECKLACES, raise)

    expect(result.nextFree).toBe(1008)
    expect(result.skipped).toEqual([
      { number: 1007, sku: 'NK1007', handle: 'necklace-1007', bySku: true, byHandle: true },
    ])
    /**
     * Raised to 1007, not 1008. `next_sku()` increments before returning, so the
     * counter must sit ONE BELOW the number it should hand out — raising to the
     * free number itself would burn one on every call.
     */
    expect(raise).toHaveBeenCalledWith('NK', 1007)
  })

  it('catches a hand-made product listed with no SKU, by its handle', async () => {
    // Very common in admin. A SKU-only probe would call 1007 free and productSet
    // would then overwrite the product sitting at that handle.
    const { client } = probeClient({ 1007: 'handle' })
    const result = await findFreeNumber(client, NECKLACES)
    expect(result.nextFree).toBe(1008)
    expect(result.skipped[0]).toMatchObject({ bySku: false, byHandle: true })
  })

  it('catches a product whose title was edited after creation, by its SKU', async () => {
    // Shopify keeps the original handle when a title changes, so the handle
    // probe misses it while the SKU is still ours to collide with.
    const { client } = probeClient({ 1007: 'sku' })
    const result = await findFreeNumber(client, NECKLACES)
    expect(result.nextFree).toBe(1008)
    expect(result.skipped[0]).toMatchObject({ bySku: true, byHandle: false })
  })

  it('walks over a whole batch listed by hand this morning', async () => {
    const { client } = probeClient({ 1007: 'both', 1008: 'both', 1009: 'sku', 1010: 'handle' })
    const raise = vi.fn()

    const result = await clearCounterOfShopifyNumbers(client, NECKLACES, raise)

    expect(result.nextFree).toBe(1011)
    expect(result.skipped.map((row) => row.number)).toEqual([1007, 1008, 1009, 1010])
    expect(raise).toHaveBeenCalledWith('NK', 1010)
  })

  it('builds the handle from the title suffix, not from the SKU', async () => {
    // rings-222-adjustable, not rings-222. Probing the wrong handle would miss a
    // collision entirely.
    const { graphql, client } = probeClient({})
    await findFreeNumber(client, {
      prefix: 'RS',
      titlePattern: 'Rings {n}',
      titleSuffix: '(Adjustable)',
      counterLastNumber: 221,
    })
    expect(graphql.mock.calls[0]?.[1]).toEqual({
      sku: 'sku:RS222',
      handle: 'rings-222-adjustable',
    })
  })

  it('gives up loudly rather than issuing a number it never checked', async () => {
    const taken = Object.fromEntries(
      Array.from({ length: MAX_NUMBER_PROBES + 5 }, (_, i) => [1007 + i, 'both' as const]),
    )
    const { client } = probeClient(taken)
    await expect(findFreeNumber(client, NECKLACES)).rejects.toThrow(/all already used in Shopify/i)
  })
})

const OWNERSHIP = {
  handle: 'necklace-1007',
  reservedSku: 'NK1007',
  recordedProductId: null,
  draftCreatedAt: '2026-08-08T08:42:38.000Z',
}

const product = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'gid://shopify/Product/10146138489129',
    title: 'Necklace 1007',
    createdAt: '2026-08-08T08:44:00.000Z',
    variants: { nodes: [{ sku: 'NK1007' }] },
    ...overrides,
  }) as never

describe('refusing to write over somebody else’s product', () => {
  it('creates freely when the handle is empty', () => {
    expect(classifyHandleOwnership(OWNERSHIP, null)).toEqual({ kind: 'free' })
  })

  it('updates the product the draft is recorded against', () => {
    expect(
      classifyHandleOwnership(
        { ...OWNERSHIP, recordedProductId: 'gid://shopify/Product/10146138489129' },
        product(),
      ),
    ).toEqual({ kind: 'ours' })
  })

  it('REFUSES the real NK1007 case — created before the draft existed', () => {
    // The manual product carried NK1007 too, because whoever made it followed
    // the same numbering convention. A SKU match alone would have adopted and
    // overwritten it; the timestamp is what settles it.
    const ownership = classifyHandleOwnership(
      OWNERSHIP,
      product({ createdAt: '2026-08-08T08:01:39.000Z' }),
    )
    expect(ownership).toMatchObject({ kind: 'foreign' })
    expect(() => assertHandleIsWritable(OWNERSHIP, ownership)).toThrow(
      /already has a different product/i,
    )
  })

  it('tells the operator what to do, and that nothing was changed', () => {
    const ownership = classifyHandleOwnership(
      OWNERSHIP,
      product({ createdAt: '2026-08-08T08:01:39.000Z' }),
    )
    try {
      assertHandleIsWritable(OWNERSHIP, ownership)
      throw new Error('should have refused')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('Nothing was changed in Shopify')
      expect(message).toContain('Full reconciliation')
    }
  })

  it('adopts its own interrupted publish — the crash window', () => {
    // productSet succeeded, the process died before the id was recorded. The
    // product postdates the draft AND carries the reserved SKU, which nobody
    // else could have arranged.
    expect(classifyHandleOwnership(OWNERSHIP, product())).toEqual({
      kind: 'adopt',
      productId: 'gid://shopify/Product/10146138489129',
    })
  })

  it('will not adopt a product that postdates the draft but carries another SKU', () => {
    expect(
      classifyHandleOwnership(OWNERSHIP, product({ variants: { nodes: [{ sku: 'NK9999' }] } })),
    ).toMatchObject({ kind: 'foreign' })
  })

  it('refuses when the recorded product was replaced by a different one', () => {
    expect(
      classifyHandleOwnership(
        { ...OWNERSHIP, recordedProductId: 'gid://shopify/Product/OLD' },
        product(),
      ),
    ).toMatchObject({ kind: 'foreign' })
  })

  it('refuses rather than guessing when Shopify reports no creation date', () => {
    expect(classifyHandleOwnership(OWNERSHIP, product({ createdAt: null }))).toMatchObject({
      kind: 'foreign',
    })
  })
})
