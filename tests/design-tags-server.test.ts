import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * D177, the server side of design labels: what labelDraftDesign reads, sends and writes. Every outside world is a
 * fake (database, Shopify, R2, the Claude call); the 1280 px previews and D175's disk cache are the real ones, in a
 * temporary directory.
 */
const mocks = vi.hoisted(() => ({
  input: null as unknown,
  product: null as unknown,
  objects: {} as Record<string, Buffer>,
  tables: [] as string[],
  events: [] as { event: string; detail: Record<string, unknown> }[],
  load: vi.fn(),
  graphql: vi.fn(),
  get: vi.fn(),
  label: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: () => ({
    from: (table: string) => {
      mocks.tables.push(table)
      return { insert: async (row: { event: string; detail: Record<string, unknown> }) => { mocks.events.push(row); return { error: null } } }
    },
  }),
}))
vi.mock('@/lib/publish/publish-product', () => ({ loadPublishInput: mocks.load }))
vi.mock('@/lib/shopify/config', () => ({ shopifyConfig: () => ({}) }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { graphql = mocks.graphql } }))
vi.mock('@/lib/console/images', () => ({ consoleObjectStore: () => ({ get: mocks.get }) }))
vi.mock('@/lib/design-tags/labeller', async (actual) => ({ ...(await actual<object>()), labelPhotos: mocks.label }))

import { fingerprint, metafieldValue } from '@/lib/design-tags/labeller'
import { labelDraftDesign } from '@/lib/design-tags/server'

const DRAFT = 'draft-1'
const PRODUCT = 'gid://shopify/Product/4700000000100'
const IDS = ['5f1e2d3c-0000-4000-8000-000000000001', '5f1e2d3c-0000-4000-8000-000000000002', '5f1e2d3c-0000-4000-8000-000000000003', '5f1e2d3c-0000-4000-8000-000000000004', '5f1e2d3c-0000-4000-8000-000000000005']
const PRINT = fingerprint(IDS.slice(0, 4), 'ER')
const LABELS = { description: 'Drop earrings.', pieces: ['earrings'], types: ['drop'] }
const mutations = () => mocks.graphql.mock.calls.filter(([query]) => /\bmutation\b/.test(query as string))

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'loupe-design-tags-test-'))
  const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#d8c9a8' } }).jpeg().toBuffer()
  mocks.objects = Object.fromEntries(IDS.map((id) => [`versions/${id}.jpg`, photo]))
})
afterAll(() => rm(dir, { recursive: true, force: true }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('IMAGE_CACHE_DIR', path.join(dir, String(Math.random()).slice(2)))
  vi.stubEnv('HOME_CLAUDE_API_KEY', 'test-key')
  vi.stubEnv('DESIGN_LABELS', '')
  mocks.tables = []
  mocks.events = []
  mocks.input = {
    draft: { shopify_product_id: PRODUCT },
    category: { sku_prefix: 'ER' },
    images: IDS.map((id) => ({ imageVersionId: id, storageKey: `versions/${id}.jpg` })),
  }
  mocks.product = { title: 'Earrings 460', options: [{ name: 'Title', values: ['Default Title'] }], metafield: null }
  mocks.load.mockImplementation(async () => mocks.input)
  mocks.get.mockImplementation(async (key: string) => mocks.objects[key] ?? Promise.reject(new Error(`missing ${key}`)))
  mocks.graphql.mockImplementation(async (query: string) => query.includes('metafieldsSet')
    ? { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } }
    : { product: mocks.product })
  mocks.label.mockResolvedValue({ labels: LABELS, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, usd: 0 } })
})

describe('labelDraftDesign', () => {
  it('does nothing more when the stored labels were made for the same photos', async () => {
    mocks.product = { ...(mocks.product as object), metafield: { value: JSON.stringify(metafieldValue(LABELS, 'earrings', PRINT, new Date())) } }
    await labelDraftDesign(DRAFT)
    expect(mocks.graphql).toHaveBeenCalledTimes(1)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.label).not.toHaveBeenCalled()
    expect(mutations()).toEqual([])
    expect(mocks.events).toEqual([])
  })

  it('labels the first four photos and writes one metafieldsSet on the draft\'s product', async () => {
    await labelDraftDesign(DRAFT)
    expect(mocks.get).toHaveBeenCalledTimes(4)
    const sent = mocks.label.mock.calls[0][0] as { photos: Buffer[]; kind: string; product: { options: unknown[] }; apiKey: string }
    expect(sent.photos).toHaveLength(4)
    expect((await sharp(sent.photos[0]).metadata()).format).toBe('webp')
    expect([sent.kind, sent.product.options, sent.apiKey]).toEqual(['earrings', [], 'test-key'])

    const written = mutations()
    expect(written).toHaveLength(1)
    expect(written[0][0]).toContain('metafieldsSet(')
    const [metafield] = (written[0][1] as { metafields: Record<string, string>[] }).metafields
    expect({ ...metafield, value: undefined }).toEqual({ ownerId: PRODUCT, namespace: 'qimati', key: 'design_labels', type: 'json', value: undefined })
    expect(JSON.parse(metafield.value)).toMatchObject({ v: 1, images: PRINT, labels: { kind: 'earrings', ...LABELS } })
    expect(mocks.events.map((e) => e.event)).toEqual(['draft.design_labelled'])

    // The same previews again come from the disk cache, not from R2.
    await labelDraftDesign(DRAFT)
    expect(mocks.get).toHaveBeenCalledTimes(4)
    expect(mocks.label).toHaveBeenCalledTimes(2)
  })

  it('records a failure and nothing else when Claude fails, and never rejects', async () => {
    mocks.label.mockRejectedValue(new Error('529 overloaded'))
    await expect(labelDraftDesign(DRAFT)).resolves.toBeUndefined()
    expect(mutations()).toEqual([])
    expect(mocks.tables).toEqual(['events'])  // the draft row is never read or written here
    expect(mocks.events).toEqual([{ entity_type: 'product_draft', entity_id: DRAFT, event: 'draft.design_label_failed', detail: { message: '529 overloaded' }, actor: 'design-tags' }])
  })

  it('does nothing at all without a product in Shopify or without photos', async () => {
    mocks.input = { ...(mocks.input as object), draft: { shopify_product_id: null } }
    await labelDraftDesign(DRAFT)
    mocks.input = { ...(mocks.input as object), draft: { shopify_product_id: PRODUCT }, images: [] }
    await labelDraftDesign(DRAFT)
    expect([mocks.graphql, mocks.get, mocks.label].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0])
    expect(mocks.events).toEqual([])
  })

  it('is off without a Claude key (one warning) and with DESIGN_LABELS=off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('HOME_CLAUDE_API_KEY', '')
    await labelDraftDesign(DRAFT)
    await labelDraftDesign(DRAFT)
    expect(warn).toHaveBeenCalledTimes(1)
    vi.stubEnv('HOME_CLAUDE_API_KEY', 'test-key')
    vi.stubEnv('DESIGN_LABELS', 'off')
    await labelDraftDesign(DRAFT)
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.events).toEqual([])
    warn.mockRestore()
  })
})
