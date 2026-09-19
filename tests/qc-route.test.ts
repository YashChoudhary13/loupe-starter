import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), load: vi.fn() }))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorIdForAction: mocks.authorize, NotAuthorisedError: class extends Error {} }))
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://loupe.example' } }))
vi.mock('@/lib/qc/server', () => ({ loadQcView: mocks.load }))
import { NotAuthorisedError } from '@/lib/auth/authorize'
import { GET, POST } from '@/app/api/qc/[orderId]/route'
const context = { params: Promise.resolve({ orderId: '1' }) }
const command = { action: 'scan', expectedGeneration: 1, requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', code: 'RS004-C-GOLD-S-7' }
const request = (body: unknown = command, origin = 'https://loupe.example') => new Request('http://localhost:3000/api/qc/1', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
beforeEach(() => { vi.resetAllMocks(); mocks.authorize.mockResolvedValue({ id: 'server-operator' }); mocks.load.mockResolvedValue({ session: { counts: { line1: 1 } } }) })
describe('QC authenticated routes', () => {
  it('requires an active operator on reads and writes', async () => {
    mocks.authorize.mockRejectedValue(new NotAuthorisedError())
    expect((await POST(request(), context)).status).toBe(401)
    expect((await GET(new Request('http://localhost:3000/api/qc/1'), context)).status).toBe(401)
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('accepts the configured proxy origin and ignores browser counts and identity', async () => {
    const response = await POST(request({ ...command, actor_id: 'attacker', variant_id: 'wrong', counts: { line1: 60 } }), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.load).toHaveBeenCalledWith('gid://shopify/Order/1', { id: 'server-operator' }, command)
  })
  it('rejects foreign origins, oversized bodies and malformed order IDs', async () => {
    expect((await POST(request(command, 'https://other.example'), context)).status).toBe(403)
    expect((await POST(request('x'.repeat(4097)), context)).status).toBe(413)
    expect((await POST(request(), { params: Promise.resolve({ orderId: 'not-an-order' }) })).status).toBe(400)
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('passes the exact retry UUID to the durable command', async () => {
    await POST(request(), context); await POST(request(), context)
    expect(mocks.load.mock.calls[0][2].requestId).toBe(mocks.load.mock.calls[1][2].requestId)
  })
  it('does not return invented progress on server failure', async () => {
    mocks.load.mockRejectedValue(new Error('Shopify unavailable.'))
    const response = await POST(request(), context)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Shopify unavailable.' })
  })
})
