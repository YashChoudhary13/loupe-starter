import sharp from 'sharp'

import type { ImageSize } from './url'

/** The editor's review size: the numbers the retired R2 backfill (original-preview.ts) used. */
export const PREVIEW_LONG_EDGE = 1280
export const PREVIEW_QUALITY = 78
export const THUMB_LONG_EDGE = 512

export interface VersionKeys {
  readonly storage_key: string
  readonly thumb_key: string | null
}

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
}

/** From the key's extension; an unknown one is served as plain bytes, never guessed. */
export function contentTypeOf(key: string): string {
  return TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Known from the row alone, so a disk-cache hit never has to open the file to name its type. */
export function contentTypeFor(version: VersionKeys, size: ImageSize): string {
  if (size === 'full') return contentTypeOf(version.storage_key)
  if (size === 'thumb' && version.thumb_key) return contentTypeOf(version.thumb_key)
  return 'image/webp'
}

function fit(input: Buffer, longEdge: number) {
  return sharp(input, { failOn: 'error' })
    .rotate()
    .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PREVIEW_QUALITY })
}

export async function makePreview(full: Buffer): Promise<Buffer> {
  return fit(full, PREVIEW_LONG_EDGE).toBuffer()
}

/**
 * The bytes for one size of one version: the stored object for `full` and for a
 * `thumb` that has one, else the preview rendered from the full file — and, for a
 * version without a stored thumbnail, a 512 px thumb cut from that preview.
 */
export async function renderSize(
  version: VersionKeys,
  size: ImageSize,
  store: { get(key: string): Promise<Buffer> },
): Promise<Buffer> {
  if (size === 'full') return store.get(version.storage_key)
  if (size === 'thumb' && version.thumb_key) return store.get(version.thumb_key)
  const preview = await makePreview(await store.get(version.storage_key))
  return size === 'preview' ? preview : fit(preview, THUMB_LONG_EDGE).toBuffer()
}
