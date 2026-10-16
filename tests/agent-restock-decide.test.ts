import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), ingest: vi.fn(), stock: vi.fn(), archive: vi.fn(), setQty: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('@/lib/console/images', () => ({ consoleObjectStore: () => ({}), signKeys: async () => new Map() }))
vi.mock('@/lib/images/image', () => ({ makeThumbnail: async () => Buffer.from('t') }))
vi.mock('@/lib/agent-intake/server', () => ({
  AGENT_IMAGE_MAX_BYTES: 25_000_000, AGENT_OPERATOR: { email: 'agent@claude.local' }, findSourcePhoto: vi.fn(), ingestAgentImage: mocks.ingest,
}))
vi.mock('@/lib/shopify/inventory', () => ({ readProductStockBySku: mocks.stock, archiveProduct: mocks.archive, setAvailableQuantities: mocks.setQty }))

import { decideRestockCandidate, deleteRestockCandidates } from '@/lib/agent-intake/restock'
import { parseRestockPayload } from '@/lib/agent-intake/suggest'
import type { Operator } from '@/lib/auth/authorize'
import { supersedeAfterPublish } from '@/lib/match/supersede'
import type { ShopifyClient } from '@/lib/shopify/client'

const owner = { id: 'o', email: 'owner@example.test', name: 'Owner', role: 'operator' } as Operator
const PHOTO = '11111111-1111-4111-8111-111111111111'
const IMG = 'https://cdn.shopify.com/s/files/1/0819/files/chain-bracelet-flat%20curb.png?v=1'
const candidate = (sku: string, extra: Record<string, unknown> = {}) => ({
  sku, handle: `chain-bracelet-${sku.slice(2)}`, image_url: IMG, status: 'ACTIVE', available: 0, created_at: '2026-01-01T00:00:00Z',
  suggest: { price_paise: 15000, archive_old: true }, ...extra,
})
const payload = parseRestockPayload({ kind: 'old', note: 'same clasp', candidates: [candidate('CB554', { created_at: '2026-09-01T00:00:00Z' }), candidate('CB483')] })

function photoRow(state: string | null = 'pending') {
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
    data: { id: PHOTO, filename: '1000168359.jpg', restock: payload, restock_state: state, agent_jobs: { label: '2026-10-12 14.30' } }, error: null,
  }) }) }) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockResolvedValue({ data: { state: 'x' }, error: null })
})

describe('the three choices on a restock candidate (D148)', () => {
  it('use old image: the chosen listing image goes to Pending as a restock, once per photograph, then the candidate closes', async () => {
    photoRow()
    const fetchMock = vi.fn(async () => new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    mocks.ingest.mockResolvedValue({ intakeId: 'i1', status: 'enhanced', duplicate: false })
    await decideRestockCandidate(owner, { photoId: PHOTO, choice: 'use_old', sku: 'CB554' })
    expect(fetchMock).toHaveBeenCalledWith(IMG, expect.anything())
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'chain-bracelet-flat curb.png', mimeType: 'image/png', tag: 'restock', restockSku: 'CB554', batch: '2026-10-12 14.30',
      sourceFilename: '1000168359.jpg', sourcePhotoId: PHOTO, dedupeSalt: `restock:${PHOTO}`,
      note: 'Same design also listed as CB483. same clasp',
      suggest: expect.objectContaining({ pricePaise: 15000, archiveOld: true, alsoArchive: ['CB483'] }),
    }))
    expect(mocks.rpc).toHaveBeenCalledWith('decide_restock_candidate', expect.objectContaining({ p_photo_id: PHOTO, p_state: 'use_old', p_sku: 'CB554', p_restock: null, p_label: null, p_actor: owner.email }))
    vi.unstubAllGlobals()
  })

  it('generate and wrong queue a render job and fetch nothing', async () => {
    photoRow()
    await decideRestockCandidate(owner, { photoId: PHOTO, choice: 'generate', sku: 'CB483' })
    expect(mocks.rpc).toHaveBeenLastCalledWith('decide_restock_candidate', expect.objectContaining({
      p_state: 'generate', p_sku: 'CB483', p_label: expect.stringMatching(/^restock \d{4}-\d\d-\d\d \d\d\.\d\d 1000168359$/),
      p_restock: { sku: 'CB483', handle: 'chain-bracelet-483', also: ['chain-bracelet-554'], also_archive: ['CB554'] },
    }))
    await decideRestockCandidate(owner, { photoId: PHOTO, choice: 'wrong', sku: null })
    expect(mocks.rpc).toHaveBeenLastCalledWith('decide_restock_candidate', expect.objectContaining({ p_state: 'wrong', p_sku: null, p_restock: null, p_label: expect.stringMatching(/^new /) }))
    expect(mocks.ingest).not.toHaveBeenCalled()
  })

  it('refuses a photograph that was already decided, and a SKU that is not on the card', async () => {
    photoRow('use_old')
    await expect(decideRestockCandidate(owner, { photoId: PHOTO, choice: 'wrong', sku: null })).rejects.toMatchObject({ operatorMessage: expect.stringMatching(/already decided/) })
    photoRow()
    await expect(decideRestockCandidate(owner, { photoId: PHOTO, choice: 'use_old', sku: 'NK1' })).rejects.toMatchObject({ operatorMessage: expect.stringMatching(/Pick which listing/) })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})

describe('delete on a restock candidate (D154)', () => {
  it('passes the cards to one call under the operator and returns the count; nothing is fetched or ingested', async () => {
    mocks.rpc.mockResolvedValue({ data: 2, error: null })
    expect(await deleteRestockCandidates(owner, [PHOTO, '22222222-2222-4222-8222-222222222222'])).toBe(2)
    expect(mocks.rpc).toHaveBeenCalledWith('delete_restock_candidates', { p_photo_ids: [PHOTO, '22222222-2222-4222-8222-222222222222'], p_actor: owner.email })
    expect(mocks.ingest).not.toHaveBeenCalled()
  })
  it('an empty list touches nothing, and a database refusal reaches the operator', async () => {
    expect(await deleteRestockCandidates(owner, [])).toBe(0)
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'delete_restock_candidates: p_actor is required', hint: null } })
    await expect(deleteRestockCandidates(owner, [PHOTO])).rejects.toMatchObject({ operatorMessage: 'The restock could not be deleted.', retryable: false })
  })
})

describe('publish archives the other sold-out SKUs of the same design (D148)', () => {
  const product = (id: string, status: string, quantity: number) => ({ productId: id, title: '', handle: '', status, variants: [{ variantId: 'v', inventoryItemId: `i-${id}`, label: 'Default', quantity }] })

  it('only live listings with no stock, never the one already superseded, and a failure there undoes nothing', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'pending_supersession') return { data: [{ decision_id: 'd1', old_sku: 'CB554', old_shopify_product_id: null }], error: null }
      if (name === 'supersession_also_skus') return { data: ['CB483', 'CB12', 'CB13', 'CB14'], error: null }
      return { data: null, error: null }
    })
    mocks.stock.mockImplementation(async (_client: unknown, sku: string) => {
      if (sku === 'CB554') return [product('p554', 'ACTIVE', 0)]
      if (sku === 'CB483') return [product('p483', 'ACTIVE', 0)]
      if (sku === 'CB12') return [product('p12', 'DRAFT', 0)]
      if (sku === 'CB13') return [product('p13', 'ACTIVE', 4)]
      throw new Error('Shopify is down')
    })
    const result = await supersedeAfterPublish({ rpc } as never, {} as ShopifyClient, 'draft-1', 'publish')
    expect(result).toEqual({ superseded: 'CB554, CB483' })
    expect(mocks.archive.mock.calls.map((call) => call[1])).toEqual(['p554', 'p483'])
    expect(rpc).toHaveBeenCalledWith('record_supersession', expect.objectContaining({ p_old_product_id: 'p554' }))
    expect(rpc).not.toHaveBeenCalledWith('fail_restock', expect.anything())
  })
})
