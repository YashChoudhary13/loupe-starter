import type { SupabaseClient } from '@supabase/supabase-js'

import type { DriveHousekeeper } from '@/lib/google/drive-types'

import type { EnhancementOutcome } from './worker'

/**
 * Moves photographs that have FINISHED FAILING out of Drive /Raw.
 *
 * Same shape as `tidyDriveForDraft`: injected dependencies, one file's failure
 * never stops the others, and a failed move changes nothing else. Hard rule 3
 * still holds — the Drive folder is an inbox, not a state machine. Nothing here
 * reads a folder to decide what is true, and nothing here alters intake status.
 *
 * **Only terminal outcomes move.** `retry_scheduled` means the photograph is
 * coming back — moving it would suggest to whoever is watching the folder that
 * Loupe had given up on work that is still queued. `failed` means the five
 * bounded attempts are spent or the error was permanent; `cost_ceiling_failed`
 * means the image cost more than the ceiling allowed. Both are over.
 *
 * Moving a file does NOT break Retry from Tracking. Drive file ids are stable
 * across folder moves and the worker downloads by id, so a retried photograph is
 * fetched from /Discarded exactly as it was from /Raw.
 *
 * What this is not: a spending guard. Re-scanning /Raw has never re-enqueued
 * anything — `drive_file_id` is UNIQUE, so a file left in place is read and
 * skipped. This keeps the folder honest for the human looking at it, which is a
 * different and smaller claim. See D68.
 */

export interface FailedFileSweepOutcome {
  readonly intakeFileId: string
  readonly driveFileId: string
  readonly ok: boolean
  /** False with `ok: true` means it was already out of /Raw — a safe repeat. */
  readonly moved: boolean
  readonly error: string | null
}

export interface FailedFileSweepDeps {
  readonly db: SupabaseClient
  readonly drive: DriveHousekeeper
  readonly discardedFolderId: string
  readonly actor: string
}

export function terminalFailures(
  outcomes: readonly EnhancementOutcome[],
): readonly EnhancementOutcome[] {
  return outcomes.filter(
    (outcome) => outcome.status === 'failed' || outcome.status === 'cost_ceiling_failed',
  )
}

export async function sweepFailedFilesOutOfRaw(
  outcomes: readonly EnhancementOutcome[],
  deps: FailedFileSweepDeps,
): Promise<readonly FailedFileSweepOutcome[]> {
  const results: FailedFileSweepOutcome[] = []

  for (const outcome of terminalFailures(outcomes)) {
    try {
      const move = await deps.drive.moveToFolder(outcome.driveFileId, deps.discardedFolderId)
      await deps.db.rpc('record_drive_housekeeping', {
        p_intake_file_id: outcome.intakeFileId,
        p_ok: true,
        p_error: null,
        p_actor: deps.actor,
      })
      results.push({
        intakeFileId: outcome.intakeFileId,
        driveFileId: outcome.driveFileId,
        ok: true,
        moved: move.moved,
        error: null,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // Records the reason and stops there. The photograph is already `failed`
      // in the database and already visible in Tracking; a stuck file in /Raw is
      // untidy, not incorrect.
      await deps.db
        .rpc('record_drive_housekeeping', {
          p_intake_file_id: outcome.intakeFileId,
          p_ok: false,
          p_error: message,
          p_actor: deps.actor,
        })
        .then(() => undefined, () => undefined)
      results.push({
        intakeFileId: outcome.intakeFileId,
        driveFileId: outcome.driveFileId,
        ok: false,
        moved: false,
        error: message,
      })
    }
  }

  return results
}
