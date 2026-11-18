import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  rows: {} as Record<string, { storage_key: string; thumb_key: string | null; purged_at: string | null }>,
  phone: {} as Record<string, { storage_key: string; status: string }>,
  objects: {} as Record<string, Buffer>,
  get: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorForAction: mocks.operator, NotAuthorisedError: class extends Error {} }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: () => ({
    from: (table: string) => {
      const wanted: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { wanted[column] = value; return query },
        maybeSingle: async () => {
          if (table === 'image_versions') return { data: mocks.rows[wanted.id] ?? null, error: null }
          const photo = table === 'agent_job_photos' ? mocks.phone[wanted.id] : undefined
          return { data: photo && photo.status === wanted.status ? photo : null, error: null }
        },
      }
      return query
    },
  }),
}))
vi.mock('@/lib/console/images', () => ({ consoleObjectStore: () => ({ get: mocks.get }) }))

import { NotAuthorisedError } from '@/lib/auth/authorize'
import { GET } from '@/app/api/images/[versionId]/route'

const FULL = '5f1e2d3c-0000-4000-8000-000000000001'
const NO_THUMB = '5f1e2d3c-0000-4000-8000-000000000002'
const PURGED = '5f1e2d3c-0000-4000-8000-000000000003'
const PHONE = '5f1e2d3c-0000-4000-8000-0000000000a1'
const PHONE_PENDING = '5f1e2d3c-0000-4000-8000-0000000000a2'
const request = (id: string, size?: string, headers: Record<string, string> = {}, kind?: string) => {
  const query = new URLSearchParams({ ...(size ? { size } : {}), ...(kind ? { kind } : {}) }).toString()
  return GET(new Request(`https://loupe.qimati-eng.site/api/images/${id}${query ? `?${query}` : ''}`, { headers }), { params: Promise.resolve({ versionId: id }) })
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'loupe-image-route-test-'))
  process.env.IMAGE_CACHE_DIR = dir
  const png = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#eee6d6' } }).png().toBuffer()
  const jpeg = await sharp({ create: { width: 3200, height: 2400, channels: 3, background: '#d8c9a8' } }).jpeg().toBuffer()
  mocks.objects = { 'manual/u1/original.png': png, 'manual/u1/thumb.webp': Buffer.from('stored thumb'), 'intake/j1/p1.jpg': jpeg }
  mocks.phone = {
    [PHONE]: { storage_key: 'intake/j1/p1.jpg', status: 'uploaded' },
    [PHONE_PENDING]: { storage_key: 'intake/j1/p2.jpg', status: 'pending' },
  }
  mocks.rows = {
    [FULL]: { storage_key: 'manual/u1/original.png', thumb_key: 'manual/u1/thumb.webp', purged_at: null },
    [NO_THUMB]: { storage_key: 'manual/u1/original.png', thumb_key: null, purged_at: null },
    [PURGED]: { storage_key: 'versions/f1/v1.png', thumb_key: null, purged_at: '2026-10-01T00:00:00Z' },
  }
})
afterAll(async () => {
  delete process.env.IMAGE_CACHE_DIR
  await rm(dir, { recursive: true, force: true })
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.operator.mockResolvedValue({ id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'admin' })
  mocks.get.mockImplementation(async (key: string) => mocks.objects[key] ?? Promise.reject(new Error(`missing ${key}`)))
})

describe('GET /api/images/[versionId]', () => {
  it('needs a signed-in operator and never touches R2 without one', async () => {
    mocks.operator.mockRejectedValueOnce(new NotAuthorisedError())
    const response = await request(FULL, 'full')
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown id, a malformed id, an unknown size and a purged version', async () => {
    expect((await request('5f1e2d3c-0000-4000-8000-00000000ffff', 'full')).status).toBe(404)
    expect((await request('../../etc/passwd', 'full')).status).toBe(404)
    expect((await request(FULL, 'huge')).status).toBe(404)
    expect((await request(PURGED, 'full')).status).toBe(404)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('serves the stored bytes with a year of private caching, an ETag and nosniff, then from disk', async () => {
    const first = await request(FULL, 'full')
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(first.headers.get('content-length')).toBe(String(mocks.objects['manual/u1/original.png'].byteLength))
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/)
    expect(Buffer.from(await first.arrayBuffer()).equals(mocks.objects['manual/u1/original.png'])).toBe(true)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    const again = await request(FULL, 'full')
    expect(again.status).toBe(200)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    const cached = await request(FULL, 'full', { 'if-none-match': etag! })
    expect(cached.status).toBe(304)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toContain(`${FULL}.full`)
  })

  it('renders the preview at 1280 px WebP by default and keeps the R2 key out of the response', async () => {
    const response = await request(FULL)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1280, 960])
    expect(JSON.stringify([...response.headers])).not.toContain('manual/u1')
  })

  it('serves the stored thumb when there is one and cuts a 512 px thumb from the preview when there is not', async () => {
    const stored = await request(FULL, 'thumb')
    expect(stored.headers.get('content-type')).toBe('image/webp')
    expect(Buffer.from(await stored.arrayBuffer()).toString()).toBe('stored thumb')
    const cut = await request(NO_THUMB, 'thumb')
    const meta = await sharp(Buffer.from(await cut.arrayBuffer())).metadata()
    expect([meta.format, meta.width]).toEqual(['webp', 512])
  })

  it('serves a phone photograph by its own row when kind=phone, and only one that was uploaded (D175)', async () => {
    const preview = await request(PHONE, undefined, {}, 'phone')
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/webp')
    expect(preview.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1280, 960])

    const full = await request(PHONE, 'full', {}, 'phone')
    expect(full.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await full.arrayBuffer()).equals(mocks.objects['intake/j1/p1.jpg'])).toBe(true)
    expect(JSON.stringify([...preview.headers, ...full.headers])).not.toContain('intake/j1')

    const small = await request(PHONE, 'thumb', {}, 'phone')
    expect((await sharp(Buffer.from(await small.arrayBuffer())).metadata()).width).toBe(512)

    // Not uploaded yet; a version's id asked for as a phone photograph; a phone photograph asked for as a version; an unknown kind.
    expect((await request(PHONE_PENDING, 'full', {}, 'phone')).status).toBe(404)
    expect((await request(FULL, 'full', {}, 'phone')).status).toBe(404)
    expect((await request(PHONE, 'full')).status).toBe(404)
    expect((await request(PHONE, 'full', {}, 'parcel')).status).toBe(404)
  })

  it('turns an R2 failure into a 502 that is not cached', async () => {
    mocks.rows['5f1e2d3c-0000-4000-8000-000000000004'] = { storage_key: 'gone/x.png', thumb_key: null, purged_at: null }
    const response = await request('5f1e2d3c-0000-4000-8000-000000000004', 'full')
    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
