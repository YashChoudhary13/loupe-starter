import 'server-only'

import { serverEnv } from '@/lib/env'
import { R2ObjectStore } from '@/lib/images/storage'
import { imageUrl, type ImageSize } from '@/lib/images/url'

import type { SignedImage } from './types'

/**
 * How the console reaches R2.
 *
 * The bucket is private (D4) and stays private. Since D165 the console's own
 * pictures come from Loupe's `/api/images/<version>?size=…` route — one stable
 * URL per version and size, behind the operator's session, served from the VPS
 * disk cache — so the browser keeps them and a refreshed snapshot downloads
 * nothing. `stableImage()` builds those.
 *
 * Presigned URLs remain for readers that cannot send a Loupe cookie or do not
 * key by version: Shopify's fetch at publish (publish.ts), the Restock and
 * Identify screens (agent-intake/restock.ts, match/**) and Tracking. Every such
 * link carries a signature and an expiry, so a copied page stops rendering
 * images fifteen minutes later rather than handing out unpublished product
 * photography indefinitely.
 *
 * Thumbnails are what the queue grid uses — a ~50 KB WebP sits next to every
 * version precisely so twenty tiles cost about a megabyte instead of fifty
 * (CLAUDE.md · Storage).
 */

/** Long enough for a batch of products, short enough that a leaked URL rots. */
export const SIGNED_URL_TTL_SECONDS = 15 * 60

/** Far enough that nothing treats a stable URL as about to expire. */
export const STABLE_IMAGE_EXPIRES_AT = Date.UTC(2100, 0, 1)

export { imageUrl }

/** The console's picture of a version (D165): Loupe's own route, cached by the browser, no signature to rot. */
export function stableImage(versionId: string, size: ImageSize): SignedImage {
  return { url: imageUrl(versionId, size), expiresAt: STABLE_IMAGE_EXPIRES_AT }
}

let cached: R2ObjectStore | undefined

export function consoleObjectStore(): R2ObjectStore {
  cached ??= new R2ObjectStore({
    endpoint: serverEnv.r2Endpoint,
    accessKeyId: serverEnv.r2AccessKeyId,
    secretAccessKey: serverEnv.r2SecretAccessKey,
    bucket: serverEnv.r2Bucket,
  })
  return cached
}

export async function signKey(
  key: string | null | undefined,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<SignedImage | null> {
  if (!key) return null
  const url = await consoleObjectStore().presignGet(key, ttlSeconds)
  return { url, expiresAt: Date.now() + ttlSeconds * 1000 }
}

/**
 * Signs many keys at once, de-duplicated.
 *
 * A draft's hero image and its thumbnail appear on both the queue tile and the
 * editor; signing the same key four times is four HMACs and four different URLs
 * for one object, which makes the browser cache miss on every one of them.
 */
export async function signKeys(
  keys: readonly (string | null | undefined)[],
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, SignedImage>> {
  const unique = [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))]
  const signed = await Promise.all(
    unique.map(async (key) => [key, await signKey(key, ttlSeconds)] as const),
  )
  const out = new Map<string, SignedImage>()
  for (const [key, value] of signed) if (value) out.set(key, value)
  return out
}
