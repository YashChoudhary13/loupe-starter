import { describe, expect, it, vi } from 'vitest'
import { listQcOrders, readQcOrder, qcShopifyError } from '@/lib/shopify/qc-orders'
import { orderFingerprint } from '@/lib/qc/snapshot'
import { orderGid, parseQcCommand } from '@/lib/qc/validation'
import type { ShopifyClient } from '@/lib/shopify/client'
import type { QcOrder } from '@/lib/qc/types'

const client = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as ShopifyClient
const header = { id: 'gid://shopify/Order/1', name: 'Qimati1', updatedAt: '2026-09-15T08:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED' }
const line = (id = '1', changes = {}) => ({ id: `gid://shopify/LineItem/${id}`, title: 'Ring', variantTitle: 'Gold / 7', sku: 'RS004', requiresShipping: true, fulfillableQuantity: 2, variant: { id: 'gid://shopify/ProductVariant/11', sku: 'RS004-C-GOLD-S-7', barcode: 'RS004-C-GOLD-S-7', title: 'Gold / 7' }, ...changes })
const page = (lines = [line()], next: string | null = null, changes = {}) => ({ order: { ...header, ...changes, lineItems: { nodes: lines, pageInfo: { hasNextPage: !!next, endCursor: next } } } })

describe('whole-order Shopify QC snapshots', () => {
  it('paginates all remaining shipping lines and rereads the header after paging', async () => {
    const graphql = vi.fn().mockResolvedValueOnce(page([line(), line('2', { requiresShipping: false })], 'next'))
      .mockResolvedValueOnce(page([line('3', { fulfillableQuantity: 0 }), line('4', { fulfillableQuantity: 1 })])).mockResolvedValueOnce({ order: header })
    const order = await readQcOrder(client(graphql), '1')
    expect(order.lines.map(x => [x.id, x.required])).toEqual([['gid://shopify/LineItem/1',2],['gid://shopify/LineItem/4',1]])
    expect(order.lines[0].sku).toBe('RS004-C-GOLD-S-7')
    expect(order.lines[0].variantTitle).toBe('Gold / 7')
    expect(graphql.mock.calls[1][1].after).toBe('next')
    expect(graphql.mock.calls[2][0]).toContain('LoupeQcOrderVersion')
    expect(graphql.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true)
  })
  it('refuses inconsistent pagination rather than accepting part of the order', async () => {
    const graphql = vi.fn().mockResolvedValue({ order: { ...header, lineItems: { nodes: [line()], pageInfo: { hasNextPage: true, endCursor: null } } } })
    await expect(readQcOrder(client(graphql), '1')).rejects.toThrow(/every order line/)
  })
  it('restarts a paginated read when the order changes in Shopify', async () => {
    const changed = { ...header, updatedAt: '2026-09-15T08:01:00Z' }
    const graphql = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce({ order: changed }).mockResolvedValueOnce(page([line('1', { fulfillableQuantity: 1 })], null, changed)).mockResolvedValueOnce({ order: changed })
    expect((await readQcOrder(client(graphql), '1')).lines[0].required).toBe(1)
    expect(graphql).toHaveBeenCalledTimes(4)
  })
  it('stops after a bounded number of mid-read order edits', async () => {
    const graphql = vi.fn().mockImplementation(async (query: string) => query.includes('Version') ? { order: { ...header, updatedAt: 'changed' } } : page())
    await expect(readQcOrder(client(graphql), '1')).rejects.toThrow(/changing in Shopify/)
    expect(graphql).toHaveBeenCalledTimes(6)
  })
  it('blocks cancelled orders, held orders, custom/deleted variants and empty checklists', async () => {
    for (const [rows, changes, reason] of [
      [[line()], { cancelledAt: '2026-09-15T08:02:00Z' }, 'cancelled'],
      [[line()], { displayFulfillmentStatus: 'ON_HOLD' }, 'on hold'],
      [[line('1', { variant: null })], {}, 'custom or deleted'],
      [[line('1', { fulfillableQuantity: 0 })], {}, 'no remaining'],
    ] as const) {
      const graphql = vi.fn().mockResolvedValueOnce(page([...rows], null, changes)).mockResolvedValueOnce({ order: { ...header, ...changes } })
      expect((await readQcOrder(client(graphql), '1')).blockedReason).toContain(reason)
    }
  })
  it('rejects duplicate line IDs and invalid quantities', async () => {
    await expect(readQcOrder(client(vi.fn().mockResolvedValue(page([line(),line()]))), '1')).rejects.toThrow(/repeated/)
    await expect(readQcOrder(client(vi.fn().mockResolvedValue(page([line('1', { fulfillableQuantity: -1 })]))), '1')).rejects.toThrow(/invalid remaining/)
  })
  it('searches only open orders with unfulfilled units and preserves safe cursor pagination', async () => {
    const graphql = vi.fn().mockResolvedValue({ orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
    await listQcOrders(client(graphql), '#Qimati5019', 'Y3Vyc29y')
    expect(graphql.mock.calls[0][1]).toEqual({ query: 'status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) name:"Qimati5019"', after: 'Y3Vyc29y' })
    await expect(listQcOrders(client(graphql), 'foo OR status:any')).rejects.toThrow(/Search by/)
  })
  it('turns a missing order scope into an operator action', () => {
    expect(qcShopifyError(new Error('Access denied for orders field.'))).toContain('enable read_orders')
  })
})

describe('QC input and fingerprint', () => {
  it('fingerprints the exact colour/size, remaining quantity and codes, independent of line order', () => {
    const order: QcOrder = { id: header.id, name: header.name, updatedAt: header.updatedAt, cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null, lines: [
      { id: 'l1', variantId: 'v1', title: 'Ring', variantTitle: 'Gold / 7', sku: 'RS004-C-GOLD-S-7', barcode: 'RS004-C-GOLD-S-7', required: 2 },
      { id: 'l2', variantId: 'v2', title: 'Ring', variantTitle: 'Gold / 8', sku: 'RS004-C-GOLD-S-8', barcode: 'RS004-C-GOLD-S-8', required: 1 },
    ] }
    expect(orderFingerprint(order)).toBe(orderFingerprint({ ...order, updatedAt: 'unrelated edit', lines: [...order.lines].reverse() }))
    for (const change of [{ required: 1 }, { variantId: 'v2' }, { barcode: 'CHANGED' }, { variantTitle: 'Silver / 7' }]) {
      expect(orderFingerprint(order)).not.toBe(orderFingerprint({ ...order, lines: [{ ...order.lines[0], ...change },order.lines[1]] }))
    }
    expect(orderFingerprint(order)).not.toBe(orderFingerprint({ ...order, cancelledAt: '2026-09-15T09:00:00Z' }))
  })
  it('accepts exact saved codes and strips browser-supplied identity/count/actor authority', () => {
    expect(parseQcCommand({ action: 'scan', expectedGeneration: 1, requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', code: ' RS004-C-GOLD-S-7 ', variantId: 'injected', count: 60, actor: 'owner' })).toEqual({ action: 'scan', expectedGeneration: 1, requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', code: 'RS004-C-GOLD-S-7' })
    expect(orderGid('1')).toBe(header.id)
    expect(() => orderGid('1/../2')).toThrow(/valid/)
    expect(() => parseQcCommand({ action: 'scan', expectedGeneration: 1, requestId: 'bad', code: 'ABC' })).toThrow(/saved once/)
    expect(() => parseQcCommand({ action: 'scan', expectedGeneration: 1, requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', code: 'NK 4' })).toThrow(/Spaces/)
    expect(() => parseQcCommand({ action: 'reset', requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', expectedVersion: 4 })).toThrow(/reason/)
    expect(() => parseQcCommand({ action: 'complete', requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5' })).toThrow(/Refresh/)
    expect(parseQcCommand({ action: 'clear_extra', requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', expectedVersion: 4, extraEventId: 'a1c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', reason: 'injected' })).toEqual({
      action: 'clear_extra', requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', expectedVersion: 4, extraEventId: 'a1c6a240-bef7-4db4-9e09-0a8bc0f6fbe5',
    })
    expect(() => parseQcCommand({ action: 'clear_extra', requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', expectedVersion: 4 })).toThrow(/extra item/)
  })
})
