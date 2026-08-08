import type { SupabaseClient } from '@supabase/supabase-js'

import type { DriveHousekeeper } from '@/lib/google/drive-types'

import type { DriveHousekeepingOutcome } from './housekeeping'

/**
 * Move every published photograph still sitting in Drive /RAW into /Processed.
 *
 * WHY THIS EXISTS SEPARATELY FROM tidyDriveForDraft
 *
 * `tidyDriveForDraft` is called from the console's publish path only. Qimati
 * does not publish from the console — the operator builds drafts, Loupe sends
 * them to Shopify as DRAFT products, and the business publishes the batch in
 * Shopify admin at launch. Reconciliation then notices and calls
 * `mark_draft_published()` (see promote.ts), which publishes the intake rows
 * correctly and never tidies Drive, because nothing on that path ever did.
 *
 * The result, measured 2026-08-08: 49 drive-sourced photographs at status
 * `published` with `drive_processed_at` null, zero `drive.housekeeping` events
 * ever recorded, and a RAW folder that only ever grew. See D92.
 *
 * WHY A SWEEP RATHER THAN A CALL INSIDE promote()
 *
 * A call inside promotion would fix new products and leave the 49 stranded
 * forever — nothing revisits a draft once it is published. A sweep keyed on the
 * DATABASE STATE rather than on an event is self-healing: it clears the existing
 * backlog on its first run, covers the promotion path, and also covers a console
 * publish whose own tidy-up failed. Hard rule 3 again — the DB says what is
 * true, and "published but never moved" is a fact this can read at any time.
 *
 * It is safe to run repeatedly. `record_drive_housekeeping` stamps
 * `drive_processed_at`, so a moved file drops out of the query, and
 * `moveToFolder` reports `moved: false` for a file already in /Processed rather
 * than failing.
 */

export interface DriveBacklogDeps {
  readonly db: SupabaseClient
  readonly drive: DriveHousekeeper
  readonly processedFolderId: string
  readonly actor: string
  /**
   * Bounds one run so a large backlog cannot hold a cron request open past its
   * time limit. Whatever is left is picked up by the next run, because the query
   * is over state rather than over a queue.
   */
  readonly limit?: number
}

export interface DriveBacklogResult {
  readonly considered: number
  readonly moved: number
  readonly failed: number
  /** True when the limit was hit, so the caller can say so rather than imply "done". */
  readonly more: boolean
  readonly outcomes: readonly DriveHousekeepingOutcome[]
}

export const DRIVE_BACKLOG_DEFAULT_LIMIT = 100

export async function tidyPublishedDriveBacklog(
  deps: DriveBacklogDeps,
): Promise<DriveBacklogResult> {
  const limit = deps.limit ?? DRIVE_BACKLOG_DEFAULT_LIMIT

  const { data, error } = await deps.db
    .from('intake_files')
    .select('id, filename, drive_file_id')
    // Published is the only state that means "this photograph is done". A
    // grouped-but-unpublished photograph belongs to a draft that may still
    // change, and moving it early would take it out of RAW for a product that
    // might never exist.
    .eq('status', 'published')
    // Catalogue-ready uploads never entered Drive. Their `manual:<uuid>`
    // identity is audit data, not a Drive file id, and moveToFolder would 404.
    .eq('source', 'drive')
    .is('drive_processed_at', null)
    .order('discovered_at', { ascending: true })
    .limit(limit + 1)
  if (error) throw new Error(`Could not read the Drive housekeeping backlog: ${error.message}`)

  const rows = (data ?? []) as { id: string; filename: string; drive_file_id: string }[]
  const more = rows.length > limit
  const batch = more ? rows.slice(0, limit) : rows

  const outcomes: DriveHousekeepingOutcome[] = []
  for (const row of batch) {
    // One file's failure never stops the others — a single revoked permission or
    // a file trashed by hand must not strand the rest of the backlog.
    try {
      const move = await deps.drive.moveToFolder(row.drive_file_id, deps.processedFolderId)
      await deps.db.rpc('record_drive_housekeeping', {
        p_intake_file_id: row.id,
        p_ok: true,
        p_error: null,
        p_actor: deps.actor,
      })
      outcomes.push({
        intakeFileId: row.id,
        filename: row.filename,
        driveFileId: row.drive_file_id,
        ok: true,
        moved: move.moved,
        error: null,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await deps.db.rpc('record_drive_housekeeping', {
        p_intake_file_id: row.id,
        p_ok: false,
        p_error: message,
        p_actor: deps.actor,
      })
      outcomes.push({
        intakeFileId: row.id,
        filename: row.filename,
        driveFileId: row.drive_file_id,
        ok: false,
        moved: false,
        error: message,
      })
    }
  }

  return {
    considered: batch.length,
    moved: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    more,
    outcomes,
  }
}
