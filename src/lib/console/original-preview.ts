import 'server-only'

import { ConsoleError } from '@/lib/console/mutations'
import { supabaseServer } from '@/lib/supabase/server'

import { stableImage } from './images'
import type { SignedImage } from './types'

/**
 * The editor's preview of a photograph's original.
 *
 * Until D165 this rendered a 1280 px WebP into R2 on first request, because a
 * Drive original had no thumbnail and the panel's only other source was the
 * multi-MB file. `/api/images/<version>?size=preview` now renders and caches that
 * preview on the VPS for every version, so this only has to name the version;
 * nothing is written to R2 any more.
 */
export async function ensureOriginalPreview(
  intakeFileId: string,
): Promise<{ imageVersionId: string; thumb: SignedImage }> {
  const { data: version, error } = await supabaseServer()
    .from('image_versions')
    .select('id')
    .eq('intake_file_id', intakeFileId)
    .eq('kind', 'original')
    .maybeSingle<{ id: string }>()
  if (error) {
    throw new ConsoleError('The original image could not be read.', error.message, true)
  }
  if (!version) {
    throw new ConsoleError('That photograph has no original version.', null, false)
  }
  return { imageVersionId: version.id, thumb: stableImage(version.id, 'preview') }
}
