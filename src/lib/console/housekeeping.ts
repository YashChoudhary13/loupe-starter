import type { SupabaseClient } from '@supabase/supabase-js'

import type { DriveHousekeeper } from '@/lib/google/drive-types'

/**
 * Post-publish Drive tidy-up.
 *
 * Deliberately NOT `server-only`, and deliberately taking every dependency by
 * injection — the same shape as the enhancement worker. The whole point of this
 * module is what happens when it FAILS, and a forced-failure path that can only
 * be exercised by breaking a real Google credential is a path nobody exercises.
 *
 * Three rules, in order of how much damage getting them wrong would do:
 *
 *   1. it runs only over rows the database already says are `published`. Tidying
 *      up before the state is safe would move a photograph out of Raw for a
 *      product that turned out not to exist;
 *   2. one file's failure does not stop the others;
 *   3. a failure records a reason and changes NOTHING else. The product stays
 *      published, the intake row stays published, and nothing is walked back to
 *      `enhanced` (hard rule 3 — Drive is an inbox, not a state machine).
 */

export interface DriveHousekeepingOutcome {
  readonly intakeFileId: string
  readonly filename: string
  readonly driveFileId: string
  readonly ok: boolean
  /** False with `ok: true` means it was already in /Processed — a safe repeat. */
  readonly moved: boolean
  readonly error: string | null
}

export interface HousekeepingDeps {
  readonly db: SupabaseClient
  readonly drive: DriveHousekeeper
  readonly processedFolderId: string
  readonly actor: string
}

export async function tidyDriveForDraft(
  draftId: string,
  deps: HousekeepingDeps,
): Promise<readonly DriveHousekeepingOutcome[]> {
  const { data, error } = await deps.db
    .from('intake_files')
    .select('id, filename, drive_file_id, source, status, drive_processed_at')
    .eq('product_draft_id', draftId)
    // Rule 1. Anything not yet published is not this function's business.
    .eq('status', 'published')
    // Catalogue-ready uploads never entered Drive /RAW. Their synthetic
    // `manual:<uuid>` identity is audit/idempotency data, not a Drive file id.
    .eq('source', 'drive')
  if (error) throw new Error(`Could not read the draft's photographs: ${error.message}`)

  const rows = (data ?? []) as {
    id: string
    filename: string
    drive_file_id: string
    drive_processed_at: string | null
  }[]

  const outcomes: DriveHousekeepingOutcome[] = []

  for (const row of rows) {
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

  return outcomes
}
