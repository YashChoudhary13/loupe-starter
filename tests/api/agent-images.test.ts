import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  begin: vi.fn(),
  verify: vi.fn(),
  put: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({
  serverEnv: { agentSecret: 'a'.repeat(64), r2Endpoint: 'https://r2.example', r2AccessKeyId: 'k', r2SecretAccessKey: 's', r2Bucket: 'b' },
}))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('@/lib/manual-upload/server', () => ({ beginManualUpload: mocks.begin, verifyUploadedObject: mocks.verify }))
vi.mock('@/lib/images/storage', () => ({ R2ObjectStore: class { putImmutable = mocks.put } }))

import { GET, POST } from '@/app/api/agent/images/route'
import { AgentInputError, parseAgentSuggest, parseRestockSku } from '@/lib/agent-intake/suggest'

const TOKEN = 'a'.repeat(64)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function request(fields: Record<string, string | Blob | undefined>, token: string | null = TOKEN): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (value instanceof Blob) form.append(key, value, 'render.png')
    else form.append(key, value)
  }
  return new Request('http://localhost:3000/api/agent/images', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  })
}
const file = () => new File([PNG], 'render.png', { type: 'image/png' })

/** The duplicate check (no row), the upload row read-back, and the finalise RPC. */
function happyDatabase() {
  mocks.from.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        maybeSingle: async () => ({ data: table === 'manual_uploads' ? { storage_key: 'manual/u1/original.png' } : null, error: null }),
      }),
    }),
  }))
  mocks.begin.mockResolvedValue({ uploadId: 'u1', uploadUrl: 'https://r2.example/put', contentType: 'image/png', expiresAt: 0 })
  mocks.verify.mockResolvedValue({ upload: { id: 'u1' }, width: 1254, height: 1254, thumbnailKey: 'manual/u1/thumb.webp', phash: '0123456789abcdef' })
  mocks.rpc.mockResolvedValue({ data: { intake_id: 'i1', status: 'enhanced', duplicate: false }, error: null })
}

describe('suggest validator', () => {
  it('accepts the documented shape and drops what it does not know', () => {
    const parsed = parseAgentSuggest(JSON.stringify({
      price_paise: 12000, material: '316L', title_suffix: '(Adjustable)', variant_kind: 'colour', colours: ['Gold', 'Silver'],
      old_handle: 'necklace-951', old_status: 'ACTIVE', available: 0, committed: 2, on_hand: 2, archive_old: true, extra: 'ignored',
    }))
    expect(parsed).toEqual({
      pricePaise: 12000, material: '316L', titleSuffix: '(Adjustable)', variantKind: 'colour', colours: ['Gold', 'Silver'],
      oldHandle: 'necklace-951', oldStatus: 'ACTIVE', available: 0, committed: 2, onHand: 2, archiveOld: true,
    })
    expect(parseAgentSuggest(undefined)).toBeNull()
    expect(parseAgentSuggest('')).toBeNull()
  })
  it('refuses a wrong material, a float price, a bad variant kind and non-JSON', () => {
    expect(() => parseAgentSuggest(JSON.stringify({ material: 'Gold' }))).toThrow(AgentInputError)
    expect(() => parseAgentSuggest(JSON.stringify({ price_paise: 120.5 }))).toThrow(/whole number/)
    expect(() => parseAgentSuggest(JSON.stringify({ variant_kind: 'colours' }))).toThrow(/variant_kind/)
    expect(() => parseAgentSuggest('{')).toThrow(/valid JSON/)
    expect(() => parseAgentSuggest('[]')).toThrow(/object/)
  })
  it('needs a SKU for a restock and checks its shape', () => {
    expect(parseRestockSku('NK951', 'restock')).toBe('NK951')
    expect(parseRestockSku(' RS391-S-7 ', 'ready')).toBe('RS391-S-7')
    expect(parseRestockSku('', 'ready')).toBeNull()
    expect(() => parseRestockSku('', 'restock')).toThrow(/restock_sku/)
    expect(() => parseRestockSku('necklace 951', 'restock')).toThrow(/NK951/)
  })
})

describe('Agent images endpoint', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('fails closed without the agent secret and never reaches the database', async () => {
    expect((await POST(request({ file: file(), tag: 'ready' }, null))).status).toBe(401)
    expect((await POST(request({ file: file(), tag: 'ready' }, 'b'.repeat(64)))).status).toBe(401)
    expect((await GET(new Request('http://localhost:3000/api/agent/images?batch=x'))).status).toBe(401)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it('rejects a bad tag, a bad suggestion, a restock without its SKU, and a missing file', async () => {
    const bad = async (fields: Record<string, string | Blob | undefined>) => {
      const response = await POST(request(fields))
      expect(response.status).toBe(400)
      return ((await response.json()) as { error: string }).error
    }
    expect(await bad({ file: file(), tag: 'approved' })).toMatch(/tag must be/)
    expect(await bad({ file: file(), tag: 'ready', suggest: '{"material":"gold"}' })).toMatch(/material/)
    expect(await bad({ file: file(), tag: 'restock' })).toMatch(/restock_sku/)
    expect(await bad({ tag: 'ready' })).toMatch(/file is missing/)
    expect(await bad({ file: new File([PNG], 'x.gif', { type: 'image/gif' }), tag: 'ready' })).toMatch(/PNG, JPEG or WebP/)
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it('stores the bytes under the manual upload key, finalises with the annotations, and answers with the intake id', async () => {
    happyDatabase()
    const response = await POST(request({
      file: file(), filename: 'necklace-shell-star.png', tag: 'restock', note: 'photo 05 = NK951 Green', restock_sku: 'NK951',
      suggest: JSON.stringify({ price_paise: 12000, material: '316L', archive_old: true }), batch: '2026-10-09 18.12.57',
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, intake_id: 'i1', status: 'enhanced', duplicate: false })
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ email: 'agent@claude.local' }), { filename: 'necklace-shell-star.png', mimeType: 'image/png', bytes: PNG.byteLength })
    expect(mocks.put).toHaveBeenCalledWith('manual/u1/original.png', expect.any(Buffer), 'image/png', expect.objectContaining({ source: 'agent-image' }))
    expect(mocks.rpc).toHaveBeenCalledWith('finalize_agent_image_upload', expect.objectContaining({
      p_upload_id: 'u1', p_thumb_key: 'manual/u1/thumb.webp', p_width: 1254, p_phash: '0123456789abcdef', p_actor: 'agent@claude.local',
      p_tag: 'restock', p_note: 'photo 05 = NK951 Green', p_restock_sku: 'NK951', p_batch: '2026-10-09 18.12.57',
      p_suggest: expect.objectContaining({ pricePaise: 12000, material: '316L', archiveOld: true }),
      p_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
  })

  it('answers a repeated file with the first row and uploads nothing', async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: 'i0', status: 'enhanced' }, error: null }) }) }) }),
    }))
    const response = await POST(request({ file: file(), tag: 'ready' }))
    expect(await response.json()).toEqual({ ok: true, intake_id: 'i0', status: 'enhanced', duplicate: true })
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('lists a batch', async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [
        { id: 'i1', filename: 'a.png', agent_tag: 'ready', agent_note: null, restock_sku: null, status: 'enhanced', product_draft_id: 'd1', discovered_at: '2026-10-10T00:00:00Z' },
      ], error: null }) }) }) }),
    }))
    const response = await GET(new Request('http://localhost:3000/api/agent/images?batch=2026-10-09', { headers: { authorization: `Bearer ${TOKEN}` } }))
    expect(await response.json()).toEqual({ ok: true, rows: [
      { intake_id: 'i1', filename: 'a.png', tag: 'ready', note: null, restock_sku: null, status: 'enhanced', draft_id: 'd1', created_at: '2026-10-10T00:00:00Z' },
    ] })
    expect((await GET(new Request('http://localhost:3000/api/agent/images', { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(400)
  })
})
