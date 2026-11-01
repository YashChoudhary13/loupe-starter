import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * The VPS disk cache behind /api/images (D165).
 *
 * One file per (version, size), written through on the first read from R2 and
 * served from disk after that. Recency is the file's mtime, bumped on every read:
 * atime is not trusted, because relatime updates it at most once a day. The sweep
 * removes files not read for IMAGE_CACHE_DAYS and, when the directory is over
 * IMAGE_CACHE_MAX_MB, the least recently read until it is under 90 % of the cap.
 * A directory that cannot be written never stops an image being served — the
 * bytes still go out from R2, and one warning is logged. Only the cache's own files
 * are counted or swept; anything else in the directory is left alone.
 */

export interface CacheConfig {
  readonly dir: string
  readonly maxBytes: number
  readonly maxAgeMs: number
}

export interface SweepResult {
  readonly files: number
  readonly bytes: number
  readonly deletedOld: number
  readonly deletedOverCap: number
  /** Names in the directory the cache did not write, never counted or deleted. */
  readonly leftAlone: number
}

export function cacheConfig(env: Readonly<Record<string, string | undefined>> = process.env): CacheConfig {
  const mb = Number(env.IMAGE_CACHE_MAX_MB)
  const days = Number(env.IMAGE_CACHE_DAYS)
  return {
    dir: env.IMAGE_CACHE_DIR?.trim() || path.join(os.tmpdir(), 'loupe-image-cache'),
    maxBytes: (mb > 0 ? mb : 2048) * 1024 * 1024,
    maxAgeMs: (days > 0 ? days : 30) * 86_400_000,
  }
}

let warned = false
function warnOnce(what: string, error: unknown): void {
  if (warned) return
  warned = true
  console.warn(
    `image cache ${what} failed; images are served from R2 without the disk cache:`,
    error instanceof Error ? error.message : String(error),
  )
}

interface Entry {
  readonly file: string
  readonly bytes: number
  readonly mtimeMs: number
}

/** `<image_version id>.<size>` as the route names it, or the temp file of a write a crash left behind. */
const CACHE_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(thumb|preview|full)(\.[0-9a-f]{8}\.tmp)?$/i

async function scan(dir: string): Promise<{ entries: Entry[]; leftAlone: number }> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { entries: [], leftAlone: 0 }
    throw error
  }
  const entries: Entry[] = []
  let leftAlone = 0
  for (const name of names) {
    // A mistyped IMAGE_CACHE_DIR (say, the shared directory holding .env) must lose nothing.
    if (!CACHE_ENTRY.test(name)) {
      leftAlone += 1
      continue
    }
    const file = path.join(dir, name)
    try {
      const info = await stat(file)
      if (info.isFile()) entries.push({ file, bytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // Removed between readdir and stat; nothing to count.
    }
  }
  return { entries, leftAlone }
}

/** Bytes in the directory as last measured, so a write can notice the cap without a scan. */
let known: { dir: string; bytes: number } | null = null
let sweeping: Promise<SweepResult> | null = null

async function account(config: CacheConfig, added: number): Promise<void> {
  if (known?.dir === config.dir) known.bytes += added
  else known = { dir: config.dir, bytes: (await scan(config.dir)).entries.reduce((sum, e) => sum + e.bytes, 0) }
  if (known.bytes > config.maxBytes) await sweepImageCache(config)
}

async function read(file: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(file)
    const now = new Date()
    void utimes(file, now, now).catch(() => {})
    return bytes
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') warnOnce('read', error)
    return null
  }
}

async function write(config: CacheConfig, file: string, bytes: Buffer): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await mkdir(config.dir, { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, file)
  } catch (error) {
    warnOnce('write', error)
    await rm(tmp, { force: true }).catch(() => {})
    return
  }
  void account(config, bytes.byteLength).catch(() => {})
}

/** The cached bytes for `name`, produced and stored on a miss. A cache problem is never the caller's problem. */
export async function cached(
  name: string,
  produce: () => Promise<Buffer>,
  config: CacheConfig = cacheConfig(),
): Promise<Buffer> {
  if (path.basename(name) !== name) throw new Error(`Cache name must be a bare file name: ${name}`)
  const file = path.join(config.dir, name)
  const hit = await read(file)
  if (hit) return hit
  const bytes = await produce()
  await write(config, file, bytes)
  return bytes
}

/** Age first, then the least recently read until the directory is under 90 % of the cap. One sweep at a time. */
export function sweepImageCache(config: CacheConfig = cacheConfig()): Promise<SweepResult> {
  sweeping ??= sweep(config).finally(() => {
    sweeping = null
  })
  return sweeping
}

async function sweep(config: CacheConfig): Promise<SweepResult> {
  const cutoff = Date.now() - config.maxAgeMs
  const { entries, leftAlone } = await scan(config.dir)
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let bytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  let deletedOld = 0
  let deletedOverCap = 0
  const kept: Entry[] = []
  for (const entry of entries) {
    if (entry.mtimeMs >= cutoff) {
      kept.push(entry)
      continue
    }
    await rm(entry.file, { force: true })
    bytes -= entry.bytes
    deletedOld += 1
  }
  if (bytes > config.maxBytes) {
    for (const entry of kept) {
      if (bytes <= config.maxBytes * 0.9) break
      await rm(entry.file, { force: true })
      bytes -= entry.bytes
      deletedOverCap += 1
    }
  }
  known = { dir: config.dir, bytes }
  return { files: entries.length - deletedOld - deletedOverCap, bytes, deletedOld, deletedOverCap, leftAlone }
}
