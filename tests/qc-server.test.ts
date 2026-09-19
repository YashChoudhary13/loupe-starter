import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ find: vi.fn(), read: vi.fn(), rpc: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { config = { storeDomain: 'qc-test.myshopify.com' } } }))
vi.mock('@/lib/shopify/barcode-lookup', () => ({ findCodeMatches: mocks.find }))
vi.mock('@/lib/shopify/qc-orders', () => ({ readQcOrder: mocks.read }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ rpc: mocks.rpc }) }))
import { clearQcResolutionCache, clearQcSnapshotCache, loadQcView, resolveQcCode } from '@/lib/qc/server'
import { ShopifyClient } from '@/lib/shopify/client'
import type { Operator } from '@/lib/auth/authorize'
const operator = { id: 'server-actor', name: 'Operator', email: 'checker@example.test', role: 'operator' } as Operator
const order = { id: 'gid://shopify/Order/1', name: 'TEST', updatedAt: '2026-09-15T08:00:00Z', cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null, lines: [] }
beforeEach(() => {
  vi.resetAllMocks()
  clearQcResolutionCache()
  mocks.find.mockResolvedValue([{ id: 'v1' }])
  mocks.read.mockResolvedValue(order)
  mocks.rpc.mockResolvedValue({ data: { session: { id: 'session1', generation: 1 }, events: [{ id: 'e1' }], shortages: [] }, error: null })
  clearQcSnapshotCache()
})
const noBackground = { background: () => {} }
describe('QC server authority', () => {
  it('requires one globally unique variant, allowing its identical SKU and barcode', async () => {
    mocks.find.mockResolvedValue([{ id: 'v1' }, { id: 'v1' }])
    expect(await resolveQcCode(new ShopifyClient(), 'CODE')).toEqual({ variantId: 'v1', rejection: null })
    clearQcResolutionCache()
    mocks.find.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
    expect((await resolveQcCode(new ShopifyClient(), 'CODE')).rejection).toContain('several variants')
    mocks.find.mockResolvedValue([])
    expect((await resolveQcCode(new ShopifyClient(), 'CODE')).rejection).toContain('not found')
  })
  it('remembers a successful global match for ten minutes per code, never a rejection', async () => {
    const client = new ShopifyClient()
    mocks.find.mockResolvedValue([])
    expect((await resolveQcCode(client, 'MISS', 1_000)).rejection).toContain('not found')
    mocks.find.mockResolvedValue([{ id: 'v9' }])
    expect((await resolveQcCode(client, 'MISS', 1_000)).variantId).toBe('v9')
    expect(mocks.find).toHaveBeenCalledTimes(2)
    mocks.find.mockResolvedValue([{ id: 'other' }])
    expect((await resolveQcCode(client, 'MISS', 1_000 + 9 * 60_000)).variantId).toBe('v9')
    expect(mocks.find).toHaveBeenCalledTimes(2)
    expect((await resolveQcCode(client, 'MISS', 1_000 + 11 * 60_000)).variantId).toBe('other')
    expect(mocks.find).toHaveBeenCalledTimes(3)
  })
  it('resolves the code before the fresh order read and sends server-derived identity', async () => {
    await loadQcView('1', operator, { action: 'scan', expectedGeneration: 1, requestId: 'request', code: 'CODE' }, noBackground)
    expect(mocks.find.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0])
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
    expect(mocks.rpc).toHaveBeenCalledWith('qc_command', expect.objectContaining({ p_actor_id: 'server-actor', p_variant_id: 'v1', p_code: 'CODE', p_snapshot: order, p_order_id: order.id, p_shop_domain: 'qc-test.myshopify.com', p_line_id: null }))
  })
  it('sends the chosen line and reason for a shortage and takes events and shortages from the RPC itself', async () => {
    mocks.rpc.mockResolvedValue({ data: { session: { id: 'session1', generation: 2 }, events: [{ id: 'e2' }], shortages: [{ ref: 12, line_id: 'l1', quantity: 1 }] }, error: null })
    const view = await loadQcView('1', operator, { action: 'short', requestId: 'request', expectedVersion: 4, lineId: 'gid://shopify/LineItem/1', reason: 'not in stock' }, noBackground)
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledWith('qc_command', expect.objectContaining({ p_action: 'short', p_line_id: 'gid://shopify/LineItem/1', p_reason: 'not in stock', p_expected_version: 4 }))
    expect(view.shortages).toEqual([{ ref: 12, line_id: 'l1', quantity: 1 }])
    expect(view.events).toEqual([{ id: 'e2' }])
    expect(view.timings?.rpcMs).toBeGreaterThanOrEqual(0)
  })
  it('reuses a fresh Shopify snapshot for a burst of scans, refreshes it in the background after 6 s, and re-reads for completion', async () => {
    let clock = 1_000_000
    const background: (() => Promise<void>)[] = []
    const options = { now: () => clock, background: (task: () => Promise<void>) => { background.push(task) } }
    const scan = (code: string) => loadQcView('1', operator, { action: 'scan', expectedGeneration: 1, requestId: 'r', code }, options)
    await loadQcView('1', operator, undefined, options)               // page load: fresh read
    await scan('A'); clock += 2_000; await scan('A'); clock += 2_000; await scan('A')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(background).toHaveLength(0)
    expect(mocks.rpc).toHaveBeenLastCalledWith('qc_command', expect.objectContaining({ p_checked_at: new Date(1_000_000).toISOString() }))
    clock += 3_000                                                     // snapshot now 7 s old: answer first, refresh after
    await scan('A')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(background).toHaveLength(1)
    mocks.read.mockResolvedValue({ ...order, lines: [{ id: 'l1', variantId: 'v1', title: 'Ring', variantTitle: null, sku: 'A', barcode: 'A', required: 2 }] })
    await background[0]()
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.rpc).toHaveBeenLastCalledWith('qc_command', expect.objectContaining({ p_action: 'sync' }))   // changed order → sync flags it stale
    await scan('A')
    expect(mocks.read).toHaveBeenCalledTimes(2)                       // the refreshed snapshot serves the next scan
    clock += 20_000
    await loadQcView('1', operator, { action: 'complete', requestId: 'r', expectedVersion: 3 }, options)
    expect(mocks.read).toHaveBeenCalledTimes(3)                       // completion always re-reads
    await scan('A')
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })
  it('never counts on an inconclusive barcode lookup or Shopify read', async () => {
    mocks.find.mockRejectedValue(new Error('Shopify lookup failed'))
    await expect(loadQcView('1', operator, { action: 'scan', expectedGeneration: 1, requestId: 'request', code: 'CODE' }, noBackground)).rejects.toThrow(/lookup failed/)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('rechecks Shopify immediately before completion and does not look up a code', async () => {
    await loadQcView('1', operator, { action: 'complete', requestId: 'request', expectedVersion: 3 }, noBackground)
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(mocks.rpc).toHaveBeenCalledWith('qc_command', expect.objectContaining({ p_action: 'complete', p_expected_version: 3 }))
  })
  it('makes an RPC failure explicitly retryable and never invents counts', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    await expect(loadQcView('1', operator, undefined, noBackground)).rejects.toThrow(/could not save this action.*Retry the same request/)
  })
})
