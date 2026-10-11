import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ post: vi.fn(), list: vi.fn(), register: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ serverEnv: { agentSecret: 'a'.repeat(64) } }))
vi.mock('@/lib/agent-intake/restock', () => ({ postRestockCandidate: mocks.post, listBatchPhotos: mocks.list, registerAgentPhoto: mocks.register }))
vi.mock('@/lib/agent-intake/server', () => ({ AGENT_IMAGE_MAX_BYTES: 25_000_000 }))

import { GET as listPhotos, POST as registerPhoto } from '@/app/api/agent/photos/route'
import { POST as postRestock } from '@/app/api/agent/restocks/route'
import { AgentInputError, parseRestockPayload, restockChoice, restockPayloadFromRow } from '@/lib/agent-intake/suggest'
import { restockCandidateDelta } from '@/lib/live/types'

const TOKEN = 'a'.repeat(64)
const IMG = 'https://cdn.shopify.com/s/files/1/0819/files/cb.png?v=1'
const candidate = (sku: string, extra: Record<string, unknown> = {}) => ({
  sku, handle: `chain-bracelet-${sku.slice(2)}`, title: `Chain Bracelet ${sku.slice(2)}`, image_url: IMG, status: 'ACTIVE', available: 0, price_paise: 15000,
  created_at: '2026-01-01T00:00:00Z', suggest: { price_paise: 15000, old_handle: `chain-bracelet-${sku.slice(2)}`, old_status: 'ACTIVE', available: 0, archive_old: true }, ...extra,
})
const json = (body: unknown, token: string | null = TOKEN) => new Request('http://localhost:3000/api/agent/restocks', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
})

beforeEach(() => vi.clearAllMocks())

describe('restock candidate validator (D148)', () => {
  it('keeps what the Restock card shows, latest listing first', () => {
    const parsed = parseRestockPayload({ kind: 'old', note: ' same clasp ', candidates: [candidate('CB483'), candidate('CB554', { created_at: '2026-09-01T00:00:00Z', status: 'DRAFT', available: 36 })] })
    expect(parsed.candidates.map((c) => c.sku)).toEqual(['CB554', 'CB483'])
    expect(parsed).toMatchObject({ kind: 'old', note: 'same clasp' })
    expect(parsed.candidates[0]).toMatchObject({ handle: 'chain-bracelet-554', imageUrl: IMG, status: 'DRAFT', available: 36, pricePaise: 15000 })
    expect(parsed.candidates[1].suggest).toMatchObject({ pricePaise: 15000, archiveOld: true, alsoArchive: [] })
    // What the column gives back is what was validated.
    expect(restockPayloadFromRow(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    expect(restockPayloadFromRow({ kind: 'maybe' })).toBeNull()
  })

  it('refuses an image that is not on Shopify, a bad SKU, a repeat, and a sure restock with nothing beside it', () => {
    expect(() => parseRestockPayload({ kind: 'old', candidates: [candidate('CB1', { image_url: 'https://evil.example/x.png' })] })).toThrow(/cdn\.shopify\.com/)
    expect(() => parseRestockPayload({ kind: 'old', candidates: [candidate('cb 1')] })).toThrow(AgentInputError)
    expect(() => parseRestockPayload({ kind: 'old', candidates: [candidate('CB1'), candidate('CB1')] })).toThrow(/same SKU/)
    expect(() => parseRestockPayload({ kind: 'old', candidates: [] })).toThrow(/at least one/)
    expect(() => parseRestockPayload({ kind: 'new', candidates: [] })).toThrow(/old or unsure/)
    expect(parseRestockPayload({ kind: 'unsure' }).candidates).toEqual([])
  })

  it('a sure restock archives the other sold-out live SKUs, and says which listing still has stock', () => {
    const payload = parseRestockPayload({ kind: 'old', note: 'same clasp', candidates: [
      candidate('CB554', { created_at: '2026-09-01T00:00:00Z', status: 'DRAFT', available: 36 }), candidate('CB483'), candidate('CB12', { status: 'ARCHIVED' }),
    ] })
    const choice = restockChoice(payload, 'CB483')!
    expect(choice.chosen.sku).toBe('CB483')
    // CB554 is a draft with stock and CB12 is already archived: neither is touched.
    expect(choice.alsoArchive).toEqual([])
    expect(choice.note).toBe('CB554 still has 36 available: not archived on publish unless you switch it on. Same design also listed as CB554, CB12. same clasp')
    expect(restockChoice(payload, 'CB554')!.alsoArchive).toEqual(['CB483'])
    expect(restockChoice(payload, 'NK1')).toBeNull()
  })

  it('look-alikes of an unsure photograph are never archived with the chosen one', () => {
    const choice = restockChoice(parseRestockPayload({ kind: 'unsure', candidates: [candidate('NK745'), candidate('NK190')] }), 'NK745')!
    expect([choice.others, choice.alsoArchive, choice.note]).toEqual([[], [], ''])
  })

  it('the badge follows the audit events', () => {
    const event = (id: number, name: string) => ({ id, entityType: 'agent_job', entityId: null, event: name, occurredAt: '' })
    expect(restockCandidateDelta([event(1, 'restock.candidate_posted'), event(2, 'restock.candidate_posted'), event(3, 'restock.candidate_decided'), event(4, 'intake.enhanced')])).toBe(1)
  })
})

describe('Agent restocks and photos endpoints (D148)', () => {
  it('fail closed without the agent secret', async () => {
    expect((await postRestock(json({}, null))).status).toBe(401)
    expect((await listPhotos(new Request('http://localhost:3000/api/agent/photos?batch=x'))).status).toBe(401)
    expect((await registerPhoto(new Request('http://localhost:3000/api/agent/photos', { method: 'POST' }))).status).toBe(401)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('posts a candidate for the named photograph and answers with its state', async () => {
    mocks.post.mockResolvedValue({ photoId: 'p1', state: 'pending' })
    const response = await postRestock(json({ batch: '2026-10-12 14.30', source_filename: '1000168359.jpg', kind: 'old', note: 'same clasp', candidates: [candidate('CB554')] }))
    expect(await response.json()).toEqual({ ok: true, photo_id: 'p1', state: 'pending' })
    expect(mocks.post).toHaveBeenCalledWith('2026-10-12 14.30', '1000168359.jpg', expect.objectContaining({ kind: 'old', note: 'same clasp' }))
    expect((await postRestock(json({ batch: 'b12', kind: 'old', candidates: [candidate('CB554')] }))).status).toBe(400)
    expect((await postRestock(json({ batch: 'b12', source_filename: 'a.jpg', kind: 'old', candidates: [candidate('CB554', { image_url: 'http://x' })] }))).status).toBe(400)
  })

  it('lists the photographs a batch holds and registers one from outside', async () => {
    mocks.list.mockResolvedValue(['a.jpg'])
    const listed = await listPhotos(new Request('http://localhost:3000/api/agent/photos?batch=zip%2018.58', { headers: { authorization: `Bearer ${TOKEN}` } }))
    expect(await listed.json()).toEqual({ ok: true, filenames: ['a.jpg'] })
    expect(mocks.list).toHaveBeenCalledWith('zip 18.58')

    mocks.register.mockResolvedValue({ photoId: 'p2', duplicate: false })
    const form = new FormData()
    form.append('file', new File([Buffer.from('jpeg')], 'b.jpg', { type: 'image/jpeg' }))
    form.append('batch', 'zip 18.58')
    const registered = await registerPhoto(new Request('http://localhost:3000/api/agent/photos', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: form }))
    expect(await registered.json()).toEqual({ ok: true, photo_id: 'p2', duplicate: false })
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ batch: 'zip 18.58', filename: 'b.jpg', mimeType: 'image/jpeg' }))
  })
})
