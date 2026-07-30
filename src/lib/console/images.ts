import 'server-only'

import { serverEnv } from '@/lib/env'
import { R2ObjectStore } from '@/lib/enhance/storage'

import type { SignedImage } from './types'

/**
 * Presigned R2 access for the console.
 *
 * The bucket is private (D4) and stays private. Nothing here produces a durable
 * URL: every link the browser receives carries a signature and an expiry, so a
 * copied console page stops rendering images fifteen minutes later rather than
 * handing out unpublished product photography indefinitely.
 *
 * Thumbnails are what the queue grid uses — the enhancement worker writes a
 * ~50 KB WebP next to every version precisely so twenty tiles cost about a
 * megabyte instead of fifty (CLAUDE.md · Storage).
 */

/** Long enough for a batch of products, short enough that a leaked URL rots. */
export const SIGNED_URL_TTL_SECONDS = 15 * 60

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
