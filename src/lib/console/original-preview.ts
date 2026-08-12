import 'server-only'

import sharp from 'sharp'

import { ConsoleError } from '@/lib/console/mutations'
import { supabaseServer } from '@/lib/supabase/server'

import { consoleObjectStore, signKey } from './images'
import type { SignedImage } from './types'

/**
 * Drive-sourced originals were inserted without a thumbnail (only generated
 * versions got one), so the editor panel's only source for "orig" was the
 * byte-for-byte Drive download — up to 50 MB rendered into a ~450px box,
 * which is why the original "never loaded" until the lightbox forced the
 * same download to finish.
 *
 * This backfills a 1280px WebP preview on first request, permanently: the
 * preview lands at a deterministic key, `image_versions.thumb_key` is
 * updated, and every later queue/draft read signs it like any other thumb.
 * Manual uploads already carry a thumb and never reach the generation path.
 */

const PREVIEW_LONG_EDGE = 1280
const PREVIEW_QUALITY = 78

function previewKey(storageKey: string): string {
  // originals/{intake_file_id}.jpg → originals/{intake_file_id}_preview.webp
  return `${storageKey.replace(/\.[a-z0-9]+$/iu, '')}_preview.webp`
}

export async function ensureOriginalPreview(
  intakeFileId: string,
): Promise<{ imageVersionId: string; thumb: SignedImage }> {
  const db = supabaseServer()
  const { data: version, error } = await db
    .from('image_versions')
    .select('id, storage_key, thumb_key')
    .eq('intake_file_id', intakeFileId)
    .eq('kind', 'original')
    .maybeSingle<{ id: string; storage_key: string; thumb_key: string | null }>()
  if (error) {
    throw new ConsoleError('The original image could not be read.', error.message, true)
  }
  if (!version) {
    throw new ConsoleError('That photograph has no original version.', null, false)
  }

  if (version.thumb_key) {
    const thumb = await signKey(version.thumb_key)
    if (!thumb) throw new ConsoleError('The original preview could not be signed.', null, true)
    return { imageVersionId: version.id, thumb }
  }

  const store = consoleObjectStore()
  const key = previewKey(version.storage_key)

  // A racing request may have generated it already — the key is deterministic,
  // so head-then-reuse is safe and skips a second multi-MB download.
  const existing = await store.head(key)
  if (!existing) {
    const original = await store.get(version.storage_key)
    let preview: Buffer
    try {
      preview = await sharp(original, { failOn: 'error' })
        .rotate()
        .resize(PREVIEW_LONG_EDGE, PREVIEW_LONG_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: PREVIEW_QUALITY })
        .toBuffer()
    } catch (cause) {
      throw new ConsoleError(
        'The original image could not be decoded for a preview.',
        cause instanceof Error ? cause.message : String(cause),
        false,
      )
    }
    await store.putImmutable(key, preview, 'image/webp', {
      'intake-id': intakeFileId,
      'image-version-id': version.id,
      source: 'original-preview-backfill',
    })
  }

  const { error: updateError } = await db
    .from('image_versions')
    .update({ thumb_key: key })
    .eq('id', version.id)
    .is('thumb_key', null)
  if (updateError) {
    // The preview object exists either way; a failed pointer update only means
    // the next request regenerates the signature from the head() branch.
    console.error('original preview pointer update failed:', updateError.message)
  }

  const thumb = await signKey(key)
  if (!thumb) throw new ConsoleError('The original preview could not be signed.', null, true)
  return { imageVersionId: version.id, thumb }
}
