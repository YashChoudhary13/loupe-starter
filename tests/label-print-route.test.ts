import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), verify: vi.fn() }))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorForAction: mocks.authorize, NotAuthorisedError: class extends Error {} }))
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://loupe.example' } }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class {} }))
vi.mock('@/lib/labels/catalogue', () => ({ readLabelVariants: mocks.read, verifyLabelCodes: mocks.verify }))
import { NotAuthorisedError } from '@/lib/auth/authorize'
import { POST } from '@/app/api/labels/print/route'
const id = 'gid://shopify/ProductVariant/1'
const request = (origin = 'https://loupe.example', extra?: string) => new Request('http://localhost:3000/api/labels/print', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: extra ?? new URLSearchParams({ width: '40', height: '25', symbology: 'qr', [`copies:${id}`]: '1', barcode: 'UNTRUSTED' }) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockResolvedValue([{ id, sku: 'NK1333-C-WHITE', barcode: 'NK1333-C-WHITE', title: 'White', inventoryQuantity: 12, product: { id: 'p1', title: 'Necklace 1333' } }])
})
describe('authenticated label printing', () => {
  it('works behind the production proxy, rereads Shopify and ignores browser-supplied barcode text', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('NK1333-C-WHITE')
    expect(html).not.toContain('UNTRUSTED')
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), [id])
    expect(mocks.verify).toHaveBeenCalledOnce()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('requires an operator before reading Shopify', async () => {
    mocks.authorize.mockRejectedValue(new NotAuthorisedError())
    expect((await POST(request())).status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('rejects a foreign origin', async () => {
    expect((await POST(request('https://other.example'))).status).toBe(403)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('bounds the actual request body even without a content-length header', async () => {
    expect((await POST(request('https://loupe.example', 'x'.repeat(32001)))).status).toBe(413)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('does not create a print sheet for ambiguous codes', async () => {
    mocks.verify.mockRejectedValue(new Error('Barcode also identifies another variant.'))
    const response = await POST(request())
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('another variant')
  })
})
