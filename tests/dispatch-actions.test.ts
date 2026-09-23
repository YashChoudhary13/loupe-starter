import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ operator: vi.fn(), stage: vi.fn(), push: vi.fn(), clientOptions: [] as unknown[] }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorForAction: mocks.operator, actorFor: (operator: { email: string }) => operator.email }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { tokens = 'shared-tokens'; constructor(options: unknown) { mocks.clientOptions.push(options) } } }))
vi.mock('@/lib/shopify/dispatch-orders', () => ({ readDispatchOrder: vi.fn(), createFulfillment: vi.fn(), dispatchShopifyError: (cause: unknown) => (cause instanceof Error ? cause.message : 'x') }))
vi.mock('@/lib/dispatch/store', () => ({ stageTracking: mocks.stage, groupOrder: vi.fn(), ungroupOrder: vi.fn(), discardParcel: vi.fn(), supabasePushStore: () => ({}) }))
vi.mock('@/lib/dispatch/push', () => ({ pushParcel: mocks.push }))
import { pushParcelAction, stageTrackingAction } from '@/app/(shell)/dispatch/actions'

const PARCEL = '3f0c5a0e-6d0b-4a53-9d2e-0a4a3b1f7c11'
const expected = () => ({ carrier: 'DTDC', tracking: 'X1234567', orderIds: ['gid://shopify/Order/1'] })
beforeEach(() => { vi.clearAllMocks(); mocks.clientOptions.length = 0; mocks.operator.mockResolvedValue({ id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'admin' }) })

describe('dispatch actions', () => {
  it('takes the actor from the session, never from the browser', async () => {
    mocks.stage.mockResolvedValue(undefined)
    expect(await stageTrackingAction({ orderId: '1', orderName: 'Qimati1', tracking: 'X1234567', by: 'forged@example.test' } as never)).toEqual({ ok: true, message: 'Saved.' })
    expect(mocks.stage).toHaveBeenCalledWith({ orderId: '1', orderName: 'Qimati1', tracking: 'X1234567', carrier: undefined, by: 'owner@example.test' })
  })
  it('returns the refusal as a sentence', async () => {
    mocks.stage.mockRejectedValue(new Error('A tracking number is 6 to 30 characters.'))
    expect(await stageTrackingAction({ orderId: '1', orderName: 'Qimati1', tracking: 'X1' })).toEqual({ ok: false, message: 'A tracking number is 6 to 30 characters.' })
  })
  it('refuses when nobody is signed in, before any work', async () => {
    mocks.operator.mockRejectedValue(new Error('Sign in again.'))
    expect((await pushParcelAction(PARCEL, expected())).ok).toBe(false); expect(mocks.push).not.toHaveBeenCalled()
  })
  it('pushes with a single-attempt writer that shares the reader\'s token manager, and forwards what was confirmed', async () => {
    mocks.push.mockResolvedValue([{ orderId: 'gid://shopify/Order/1', orderName: 'Qimati1', status: 'fulfilled', message: 'Fulfilled with DTDC X1234567.' }])
    const outcome = await pushParcelAction(PARCEL, expected())
    expect(outcome).toMatchObject({ ok: true, message: '1 order fulfilled.' })
    expect(mocks.clientOptions[0]).toBeUndefined()
    expect(mocks.clientOptions[1]).toEqual(expect.objectContaining({ retryDelaysMs: [0], tokens: 'shared-tokens' }))
    expect(typeof (mocks.clientOptions[1] as { fetchImpl?: unknown }).fetchImpl).toBe('function')
    expect(mocks.push.mock.calls[0].slice(0, 2)).toEqual([PARCEL, 'owner@example.test'])
    expect(mocks.push.mock.calls[0][3]).toEqual(expected())
  })
  it('rejects a parcel id that is not a uuid', async () => { expect((await pushParcelAction('1; drop table', expected())).ok).toBe(false); expect(mocks.push).not.toHaveBeenCalled() })
  it('rejects confirmed values that are not a carrier, a number and 1-50 Shopify order ids', async () => {
    for (const bad of [
      { ...expected(), carrier: 7 },
      { ...expected(), tracking: null },
      { ...expected(), orderIds: [] },
      { ...expected(), orderIds: ['1; drop table'] },
      { ...expected(), orderIds: Array.from({ length: 51 }, (_, n) => `gid://shopify/Order/${n + 1}`) },
      undefined,
    ]) expect((await pushParcelAction(PARCEL, bad as never)).ok).toBe(false)
    expect(mocks.push).not.toHaveBeenCalled()
  })
})
