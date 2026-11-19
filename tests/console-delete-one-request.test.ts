/**
 * Deleting several photographs is one request.
 *
 * On 2026-11-19 the owner deleted 20 photographs in the Console, refreshed, and all were back. The tiles leave the
 * screen at the click, but the browser sent one server action per photograph, and a browser sends server actions one
 * after another: a reload cancelled every delete that had not started yet. The same shape as D151 (Save draft).
 * Now the ids travel in one request, so once it reaches the server nothing the browser does can split it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  rpc: vi.fn(),
  discard: vi.fn(),
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
vi.mock('@/lib/auth/authorize', () => ({ NotAuthorisedError: class extends Error { constructor(message?: string) { super(message) } }, requireOperatorForAction: mocks.operator }))
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
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ rpc: mocks.rpc }) }))
vi.mock('@/lib/tracking/discard', () => ({ discardHeldIntake: mocks.discard }))
vi.mock('@/lib/agent-intake/server', () => ({ setAgentSupersession: vi.fn() }))
vi.mock('@/lib/agent-jobs/server', () => ({ requestReenhance: vi.fn() }))

import { deleteUngroupedPhotosAction } from '@/app/(shell)/console/actions'

describe('deleteUngroupedPhotosAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.operator.mockResolvedValue({ id: 'u1', email: 'owner@example.test', name: 'Owner' })
    mocks.rpc.mockImplementation(async (...[, args]: [string, { p_intake_file_id: string }]) =>
      args.p_intake_file_id === 'grouped'
        ? { error: { code: '55000', message: 'belongs to a product', hint: 'This photograph belongs to a product draft. It cannot be deleted from the console.' } }
        : { error: null })
    mocks.discard.mockResolvedValue({ objectsDeleted: 2 })
  })

  it('deletes every photograph of the request and reports the one that was refused', async () => {
    const result = await deleteUngroupedPhotosAction(['a', 'grouped', 'b'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.deleted).toEqual(['a', 'b'])
    expect(result.data.failed.map((f) => f.intakeFileId)).toEqual(['grouped'])
    expect(result.data.failed[0].error.message).toContain('belongs to a product draft')
    expect(mocks.discard.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })

  it('checks the operator once and refuses the whole request without one', async () => {
    const { NotAuthorisedError } = await import('@/lib/auth/authorize')
    mocks.operator.mockRejectedValue(new NotAuthorisedError())
    const result = await deleteUngroupedPhotosAction(['a', 'b'])
    expect(result.ok).toBe(false)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a request larger than the grid can hold', async () => {
    const result = await deleteUngroupedPhotosAction(Array.from({ length: 501 }, (_, i) => `p${i}`))
    expect(result.ok).toBe(false)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
