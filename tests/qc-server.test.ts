import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ find: vi.fn(), read: vi.fn(), rpc: vi.fn(), history: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { config = { storeDomain: 'qc-test.myshopify.com' } } }))
vi.mock('@/lib/shopify/barcode-lookup', () => ({ findCodeMatches: mocks.find }))
vi.mock('@/lib/shopify/qc-orders', () => ({ readQcOrder: mocks.read }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ rpc: mocks.rpc, from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => ({ limit: mocks.history }) }) }) }) }) }) }))
import { loadQcView, resolveQcCode } from '@/lib/qc/server'
import { ShopifyClient } from '@/lib/shopify/client'
import type { Operator } from '@/lib/auth/authorize'
const operator = { id: 'server-actor', name: 'Operator', email: 'checker@example.test', role: 'operator' } as Operator
const order = { id: 'gid://shopify/Order/1', name: 'TEST', updatedAt: '2026-09-15T08:00:00Z', cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null, lines: [] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.find.mockResolvedValue([{ id: 'v1' }])
  mocks.read.mockResolvedValue(order)
  mocks.rpc.mockResolvedValue({ data: { session: { id: 'session1' } }, error: null })
  mocks.history.mockResolvedValue({ data: [], error: null })
})
describe('QC server authority', () => {
  it('requires one globally unique variant, allowing its identical SKU and barcode', async () => {
    mocks.find.mockResolvedValue([{ id: 'v1' }, { id: 'v1' }])
    expect(await resolveQcCode(new ShopifyClient(), 'CODE')).toEqual({ variantId: 'v1', rejection: null })
    mocks.find.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
    expect((await resolveQcCode(new ShopifyClient(), 'CODE')).rejection).toContain('several variants')
    mocks.find.mockResolvedValue([])
    expect((await resolveQcCode(new ShopifyClient(), 'CODE')).rejection).toContain('not found')
  })
  it('resolves the code before the fresh order read and sends server-derived identity', async () => {
    await loadQcView('1', operator, { action: 'scan', expectedGeneration: 1, requestId: 'request', code: 'CODE' })
    expect(mocks.find.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0])
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
    expect(mocks.rpc).toHaveBeenCalledWith('qc_command', expect.objectContaining({ p_actor_id: 'server-actor', p_variant_id: 'v1', p_code: 'CODE', p_snapshot: order, p_order_id: order.id, p_shop_domain: 'qc-test.myshopify.com' }))
  })
  it('never counts on an inconclusive barcode lookup or Shopify read', async () => {
    mocks.find.mockRejectedValue(new Error('Shopify lookup failed'))
    await expect(loadQcView('1', operator, { action: 'scan', expectedGeneration: 1, requestId: 'request', code: 'CODE' })).rejects.toThrow(/lookup failed/)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('rechecks Shopify immediately before completion and does not look up a code', async () => {
    await loadQcView('1', operator, { action: 'complete', requestId: 'request', expectedVersion: 3 })
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(mocks.rpc).toHaveBeenCalledWith('qc_command', expect.objectContaining({ p_action: 'complete', p_expected_version: 3 }))
  })
  it('makes a saved-but-history-failed request explicitly retryable', async () => {
    mocks.history.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    await expect(loadQcView('1', operator)).rejects.toThrow(/saved the action.*Retry the same request/)
  })
})
