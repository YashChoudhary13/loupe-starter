import { chmod, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { cacheConfig, cached, sweepImageCache, type CacheConfig } from '@/lib/images/cache'
import { contentTypeFor, makePreview, renderSize } from '@/lib/images/preview'
import { imageUrl, isImageSize } from '@/lib/images/url'

/**
 * D165: the console's pictures come from Loupe's own route, cached on the VPS disk.
 * The cache must serve what it wrote, forget what nobody reads, stay under its cap,
 * and get out of the way when the disk is not writable.
 */

const DAY = 86_400_000
let root: string
const config = (dir: string, over: Partial<CacheConfig> = {}): CacheConfig => ({ dir, maxBytes: 10 * 1024 * 1024, maxAgeMs: 30 * DAY, ...over })
const bytesOf = (text: string) => Buffer.from(text)
const names = async (dir: string) => (await readdir(dir)).sort()

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'loupe-image-cache-test-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('image URLs', () => {
  it('builds one stable URL per version and size, defaulting to the preview', () => {
    expect(imageUrl('5f1e2d3c-0000-4000-8000-000000000001', 'thumb')).toBe('/api/images/5f1e2d3c-0000-4000-8000-000000000001?size=thumb')
    expect(imageUrl('v1')).toBe('/api/images/v1?size=preview')
    expect(isImageSize('full')).toBe(true)
    expect(isImageSize('huge')).toBe(false)
  })

  it('reads its settings from the environment with sane defaults', () => {
    expect(cacheConfig({})).toEqual({ dir: path.join(os.tmpdir(), 'loupe-image-cache'), maxBytes: 2048 * 1024 * 1024, maxAgeMs: 30 * DAY })
    expect(cacheConfig({ IMAGE_CACHE_DIR: '/srv/cache ', IMAGE_CACHE_MAX_MB: '512', IMAGE_CACHE_DAYS: '7' })).toEqual({ dir: '/srv/cache', maxBytes: 512 * 1024 * 1024, maxAgeMs: 7 * DAY })
  })
})

describe('disk cache', () => {
  it('writes through on a miss and serves from disk after, bumping recency on read', async () => {
    const dir = path.join(root, 'rw')
    const produce = vi.fn(async () => bytesOf('picture'))
    expect((await cached('v1.full', produce, config(dir))).toString()).toBe('picture')
    expect(produce).toHaveBeenCalledTimes(1)
    const file = path.join(dir, 'v1.full')
    const old = new Date(Date.now() - 5 * DAY)
    await utimes(file, old, old)
    expect((await cached('v1.full', produce, config(dir))).toString()).toBe('picture')
    expect(produce).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => expect((await stat(file)).mtimeMs).toBeGreaterThan(old.getTime() + DAY))
    expect(await names(dir)).toEqual(['v1.full'])
  })

  it('refuses a name that is not a bare file name', async () => {
    await expect(cached('../v1.full', async () => bytesOf('x'), config(path.join(root, 'rw')))).rejects.toThrow(/bare file name/)
  })

  it('sweeps files nobody has read for the age limit', async () => {
    const dir = path.join(root, 'age')
    await cached('old.thumb', async () => bytesOf('old'), config(dir))
    await cached('fresh.thumb', async () => bytesOf('fresh'), config(dir))
    const stale = new Date(Date.now() - 31 * DAY)
    await utimes(path.join(dir, 'old.thumb'), stale, stale)
    expect(await sweepImageCache(config(dir))).toEqual({ files: 1, bytes: 5, deletedOld: 1, deletedOverCap: 0 })
    expect(await names(dir)).toEqual(['fresh.thumb'])
  })

  it('over the cap, drops the least recently read files until it is under 90 % of it', async () => {
    const dir = path.join(root, 'cap')
    const now = Date.now()
    for (const [name, age] of [['a.full', 4], ['b.full', 3], ['c.full', 2], ['d.full', 1]] as const) {
      await cached(name, async () => Buffer.alloc(100, 1), config(dir))
      await utimes(path.join(dir, name), new Date(now - age * DAY), new Date(now - age * DAY))
    }
    // 400 bytes on a 350-byte cap: a (oldest) goes, 300 > 315? no — 300 ≤ 315 stops there.
    expect(await sweepImageCache(config(dir, { maxBytes: 350 }))).toEqual({ files: 3, bytes: 300, deletedOld: 0, deletedOverCap: 1 })
    expect(await names(dir)).toEqual(['b.full', 'c.full', 'd.full'])
    // Under the cap nothing moves.
    expect(await sweepImageCache(config(dir, { maxBytes: 350 }))).toEqual({ files: 3, bytes: 300, deletedOld: 0, deletedOverCap: 0 })
  })

  it('a missing directory sweeps to nothing without complaint', async () => {
    expect(await sweepImageCache(config(path.join(root, 'never-made')))).toEqual({ files: 0, bytes: 0, deletedOld: 0, deletedOverCap: 0 })
  })

  it('still serves the bytes when the directory cannot be written, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const blocked = path.join(root, 'blocked')
    await writeFile(blocked, 'not a directory')
    const produce = vi.fn(async () => bytesOf('served anyway'))
    expect((await cached('v9.preview', produce, config(path.join(blocked, 'cache')))).toString()).toBe('served anyway')
    expect((await cached('v9.preview', produce, config(path.join(blocked, 'cache')))).toString()).toBe('served anyway')
    expect(produce).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/image cache (read|write) failed; images are served from R2/)
    await chmod(blocked, 0o644)
  })
})

describe('preview rendering', () => {
  const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#eee6d6' } }).png().toBuffer()

  it('fits the long edge to 1280 px as WebP and never enlarges', async () => {
    const preview = await makePreview(await png(2000, 1500))
    const meta = await sharp(preview).metadata()
    expect(meta.format).toBe('webp')
    expect([meta.width, meta.height]).toEqual([1280, 960])
    const small = await sharp(await makePreview(await png(640, 480))).metadata()
    expect([small.width, small.height]).toEqual([640, 480])
  })

  it('serves the stored object for full and for a thumb that exists, and cuts a 512 px thumb from the preview otherwise', async () => {
    const full = await png(1600, 1200)
    const objects: Record<string, Buffer> = { 'originals/f1.png': full, 'manual/u1/thumb.webp': bytesOf('stored thumb') }
    const store = { get: vi.fn(async (key: string) => objects[key] ?? Promise.reject(new Error(`missing ${key}`))) }
    const withThumb = { storage_key: 'originals/f1.png', thumb_key: 'manual/u1/thumb.webp' }
    const noThumb = { storage_key: 'originals/f1.png', thumb_key: null }
    expect(await renderSize(withThumb, 'full', store)).toBe(full)
    expect((await renderSize(withThumb, 'thumb', store)).toString()).toBe('stored thumb')
    const thumb = await sharp(await renderSize(noThumb, 'thumb', store)).metadata()
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 512, 384])
    const preview = await sharp(await renderSize(noThumb, 'preview', store)).metadata()
    expect([preview.width, preview.height]).toEqual([1280, 960])
    expect(contentTypeFor(withThumb, 'full')).toBe('image/png')
    expect(contentTypeFor(withThumb, 'thumb')).toBe('image/webp')
    expect(contentTypeFor({ storage_key: 'originals/f2.JPG', thumb_key: null }, 'full')).toBe('image/jpeg')
    expect(contentTypeFor({ storage_key: 'originals/f3.bin', thumb_key: null }, 'full')).toBe('application/octet-stream')
    expect(contentTypeFor(noThumb, 'thumb')).toBe('image/webp')
  })
})
