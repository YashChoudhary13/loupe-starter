/**
 * One click on Save draft is one request (D151).
 *
 * On 2026-10-13 a necklace was drafted like nine others that hour and never
 * reached Shopify: `product_drafts` held an empty row (no SKU, no price, stock
 * 0) and its only event was `draft.created`. The click used to be two requests
 * — `groupPhotosAction` created the draft, and only its reply let the browser
 * send `saveDraftAction` with what the operator had typed. The page reloaded in
 * between (nginx logged the first POST as 499), so the second was never sent
 * and the typing existed nowhere. The same thing happened on 2026-08-17.
 *
 * The draft is now created inside the request that saves or publishes it, so
 * once that request reaches the server nothing the browser does can split it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  reserve: vi.fn(),
  publish: vi.fn(),
  push: vi.fn(),
  loadDraft: vi.fn(),
  loadQueue: vi.fn(),
  after: [] as (() => Promise<void>)[],
  order: [] as string[],
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', () => ({ after: (task: () => Promise<void>) => { mocks.after.push(task) } }))
vi.mock('@/lib/auth/authorize', () => ({ NotAuthorisedError: class extends Error {}, requireOperatorForAction: mocks.operator }))
vi.mock('@/lib/categories/validation', () => ({ validateCategoryInput: vi.fn() }))
vi.mock('@/lib/console/mutations', () => ({
  ConsoleError: class ConsoleError extends Error {
    constructor(readonly operatorMessage: string, readonly detail: string | null = null, readonly retryable = true) { super(operatorMessage) }
  },
  createDraftFromPhotos: mocks.create,
  detachPhoto: vi.fn(),
  saveDraft: mocks.save,
}))
vi.mock('@/lib/console/publish', () => ({
  describeBlocks: vi.fn(async () => []),
  publishDraftForOperator: mocks.publish,
  PublishInProgressError: class extends Error {},
  reserveDraftIdentity: mocks.reserve,
}))
vi.mock('@/lib/console/shopify-push', () => ({ pushDraftToShopifyInBackground: mocks.push }))
vi.mock('@/lib/console/draft-labels', () => ({ loadDraftLabelOffer: vi.fn(), markDraftLabelsPrinted: vi.fn() }))
vi.mock('@/lib/console/queue', () => ({
  loadColourSuggestions: vi.fn(async () => []),
  loadCatalog: vi.fn(),
  loadDraft: mocks.loadDraft,
  loadPhotos: vi.fn(),
  loadQueue: mocks.loadQueue,
}))
vi.mock('@/lib/publish/validate', () => ({ PublishBlockedError: class extends Error { blocks = [] } }))
vi.mock('@/lib/manual-upload/server', () => ({ beginManualUpload: vi.fn(), finalizeManualUpload: vi.fn() }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class {} }))
vi.mock('@/lib/shopify/product-set', () => ({ deleteProduct: vi.fn(), readProductByHandle: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: vi.fn() }))
vi.mock('@/lib/agent-intake/restock', () => ({ phonePhotoUrl: vi.fn() }))
vi.mock('@/lib/agent-intake/server', () => ({ setAgentSupersession: vi.fn() }))
vi.mock('@/lib/agent-jobs/server', () => ({ requestReenhance: vi.fn() }))

import { autosaveDraftAction, publishDraftAction, saveDraftAction, type SaveDraftRequest } from '@/app/(shell)/console/actions'

const OPERATOR = { id: 'u1', email: 'owner@example.test', name: 'Owner' }
const QUEUE = { tiles: [] }

/** What the editor holds for a product that is still a selection of photographs. */
function typed(patch: Partial<SaveDraftRequest> = {}): SaveDraftRequest {
  return {
    draftId: null,
    photoIds: ['photo-1', 'photo-2'],
    expectedUpdatedAt: null,
    categoryId: 'cat-necklaces',
    materialId: 'mat-304',
    customMaterial: null,
    descriptionOverride: null,
    titleSuffix: null,
    pricePaise: 11000,
    weightG: null,
    stock: 24,
    variantKind: 'none',
    variants: [],
    images: [],
    allowZeroStock: false,
    ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.after.length = 0
  mocks.order.length = 0
  mocks.operator.mockResolvedValue(OPERATOR)
  mocks.create.mockImplementation(async () => { mocks.order.push('create'); return 'draft-new' })
  mocks.save.mockImplementation(async () => { mocks.order.push('save'); return '2026-10-13T12:12:02.000Z' })
  mocks.reserve.mockImplementation(async () => { mocks.order.push('reserve') })
  mocks.push.mockResolvedValue(undefined)
  mocks.publish.mockImplementation(async () => {
    mocks.order.push('publish')
    return { result: { sku: 'NK1847', title: 'Necklace 1847', handle: 'necklace-1847', shopifyProductId: 'gid://shopify/Product/1', reusedIdentity: false, salesChannels: [] }, shopifyStatus: 'ACTIVE', media: [] }
  })
  mocks.loadDraft.mockImplementation(async (id: string) => ({ id, categoryId: 'cat-necklaces' }))
  mocks.loadQueue.mockResolvedValue(QUEUE)
})

describe('Save draft from a selection of photographs', () => {
  it('creates the draft, saves the typing and reserves the SKU in one call', async () => {
    const result = await saveDraftAction(typed())

    expect(mocks.order).toEqual(['create', 'save', 'reserve'])
    expect(mocks.create).toHaveBeenCalledWith(OPERATOR, 'cat-necklaces', ['photo-1', 'photo-2'])
    // The draft was made a moment ago by this same request: nobody can have edited it.
    expect(mocks.save).toHaveBeenCalledWith(OPERATOR, expect.objectContaining({ draftId: 'draft-new', expectedUpdatedAt: null, pricePaise: 11000, stock: 24, materialId: 'mat-304' }))
    expect(mocks.reserve).toHaveBeenCalledWith('draft-new', OPERATOR)
    // The reply carries the queue, so the grouped photographs leave Pending without a second request.
    expect(result).toMatchObject({ ok: true, data: { bundle: { draft: { id: 'draft-new' } }, queue: QUEUE } })
  })

  it('sends the new draft to Shopify after the reply, like any other save', async () => {
    await saveDraftAction(typed({ allowZeroStock: true }))
    expect(mocks.push).not.toHaveBeenCalled()
    await Promise.all(mocks.after.map((task) => task()))
    expect(mocks.push).toHaveBeenCalledWith('draft-new', OPERATOR, true)
  })

  it('names the draft it created when a later step fails, so the browser can stay on it', async () => {
    mocks.reserve.mockRejectedValue(new Error('Shopify did not answer'))
    const result = await saveDraftAction(typed())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.createdDraftId).toBe('draft-new')
    expect(result.error.message).toMatch(/typing was saved/)
  })

  it('creates nothing when the draft itself is refused', async () => {
    mocks.create.mockRejectedValue(new Error('another operator grouped one of these photographs first'))
    const result = await saveDraftAction(typed())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.createdDraftId).toBeUndefined()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.reserve).not.toHaveBeenCalled()
  })
})

describe('an existing draft', () => {
  it('is saved as before: no second draft, no queue read', async () => {
    const result = await saveDraftAction(typed({ draftId: 'draft-7', photoIds: undefined, expectedUpdatedAt: '2026-10-13T12:00:00.000Z' }))
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.order).toEqual(['save', 'reserve'])
    expect(mocks.save).toHaveBeenCalledWith(OPERATOR, expect.objectContaining({ draftId: 'draft-7', expectedUpdatedAt: '2026-10-13T12:00:00.000Z' }))
    expect(result).toMatchObject({ ok: true, data: { bundle: { draft: { id: 'draft-7' } }, queue: null } })
  })
})

describe('Publish from a selection of photographs', () => {
  it('creates the draft inside the same call', async () => {
    const result = await publishDraftAction(typed())
    expect(mocks.order).toEqual(['create', 'save', 'publish'])
    expect(mocks.publish).toHaveBeenCalledWith('draft-new', OPERATOR, { allowZeroStock: false })
    expect(result).toMatchObject({ ok: true, data: { summary: { sku: 'NK1847' } } })
  })

  it('names the draft it created when the publish is refused', async () => {
    mocks.publish.mockRejectedValue(new Error('Shopify refused the product'))
    const result = await publishDraftAction(typed())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.createdDraftId).toBe('draft-new')
  })
})

describe('autosave', () => {
  it('never turns a selection into a product', async () => {
    const result = await autosaveDraftAction(typed())
    expect(result.ok).toBe(false)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
