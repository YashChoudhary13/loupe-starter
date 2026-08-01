import 'server-only'

import { consoleObjectStore } from '@/lib/console/images'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * R2 retention.
 *
 * Seven days after a product reaches Shopify — published, or saved there as a
 * draft (D60) — its R2 objects are redundant: Shopify serves the published
 * image from its own CDN, and Google Drive `/Processed` still holds the
 * untouched original. Without this, every original (up to 50 MB) and every
 * generated version accumulates in the bucket forever.
 *
 * What is deleted and what is emphatically NOT:
 *
 *   deleted   the bytes — original, generated versions, thumbnails
 *   kept      the `image_versions` ROW, forever
 *
 * The row carries the exact model and the exact `prompt_text` behind every
 * published image. That record is the whole mitigation for silent style drift
 * (D5) — it is what makes "these forty products look different, and here is the
 * model string that produced them" answerable months later. Deleting it to
 * reclaim a few hundred bytes would trade the audit trail for nothing.
 */

export const RETENTION_DAYS = 7

export interface PurgeResult {
  readonly candidates: number
  readonly objectsDeleted: number
  readonly versionsPurged: number
  readonly failures: readonly { readonly key: string; readonly reason: string }[]
}

interface CandidateRow {
  image_version_id: string
  intake_file_id: string
  storage_key: string | null
  thumb_key: string | null
}

export async function runRetentionPurge(
  options: { days?: number; limit?: number; actor?: string } = {},
): Promise<PurgeResult> {
  const days = options.days ?? RETENTION_DAYS
  const limit = options.limit ?? 200
  const db = supabaseServer()

  const { data, error } = await db.rpc('retention_candidates', {
    p_days: days,
    p_limit: limit,
  })
  if (error) throw new Error(`retention_candidates: ${error.message}`)

  const candidates = (data ?? []) as CandidateRow[]
  if (candidates.length === 0) {
    return { candidates: 0, objectsDeleted: 0, versionsPurged: 0, failures: [] }
  }

  const store = consoleObjectStore()
  const failures: { key: string; reason: string }[] = []
  const purgeable: string[] = []
  let objectsDeleted = 0

  for (const row of candidates) {
    const keys = [row.storage_key, row.thumb_key].filter(
      (key): key is string => typeof key === 'string' && key.length > 0,
    )

    let allGone = true
    for (const key of keys) {
      try {
        await store.delete(key)
        objectsDeleted += 1
      } catch (cause) {
        allGone = false
        failures.push({
          key,
          reason: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }

    // Only mark a version purged when every one of its objects is actually
    // gone. Marking it on a partial failure would strand the survivor: nothing
    // would ever look at that key again, and it would sit in the bucket
    // permanently, invisible and still billed.
    if (allGone) purgeable.push(row.image_version_id)
  }

  const { data: purged, error: markError } = await db.rpc('mark_versions_purged', {
    p_image_version_ids: purgeable,
    p_actor: options.actor ?? 'cron:retention',
  })
  if (markError) {
    throw new Error(
      `${objectsDeleted} R2 object(s) were deleted but could not be recorded: ${markError.message}. ` +
        'Re-running is safe — a deleted key simply deletes again.',
    )
  }

  return {
    candidates: candidates.length,
    objectsDeleted,
    versionsPurged: (purged as number | null) ?? 0,
    failures,
  }
}
