import type {
  DriveChange,
  DriveReader,
} from '@/lib/google/drive-types'

import { discoverFiles } from './files'
import {
  type IntakeRepository,
  IntakeRepositoryError,
  type SyncStateLease,
} from './repository'
import { reconcileRawFolder } from './reconcile'

export const DRIVE_SYNC_STATE_KEY = 'google-drive-change-token'
export const DRIVE_SYNC_LEASE_SECONDS = 300

export interface WatchResult {
  readonly mode: 'busy' | 'bootstrap' | 'incremental'
  readonly scanned: number
  readonly inserted: number
}

interface ChangeReplayResult {
  readonly nextCursor: string
  readonly scanned: number
  readonly inserted: number
}

function changedFiles(changes: readonly DriveChange[]) {
  return changes
    .filter((change) => !change.removed && change.file !== null)
    .map((change) => change.file)
    .filter((file): file is NonNullable<typeof file> => file !== null)
}

/**
 * Replays every page from one persisted token and returns only the final
 * `newStartPageToken`. Intermediate `nextPageToken` values are navigation, never
 * durable cursors.
 */
async function replayChanges(
  drive: DriveReader,
  repository: IntakeRepository,
  rawFolderId: string,
  startCursor: string,
): Promise<ChangeReplayResult> {
  let pageToken = startCursor
  const seenTokens = new Set<string>([startCursor])
  let scanned = 0
  let inserted = 0

  while (true) {
    const page = await drive.listChangesPage(pageToken)
    scanned += page.changes.length

    const pageResult = await discoverFiles(
      repository,
      changedFiles(page.changes),
      rawFolderId,
      'watch',
    )
    inserted += pageResult.inserted

    if (page.nextPageToken) {
      if (seenTokens.has(page.nextPageToken)) {
        throw new IntakeRepositoryError(
          'Google Drive repeated a change page token; the saved cursor was left unchanged.',
          { retryable: false, detail: { pageToken: page.nextPageToken } },
        )
      }
      seenTokens.add(page.nextPageToken)
      pageToken = page.nextPageToken
      continue
    }

    if (!page.newStartPageToken) {
      throw new IntakeRepositoryError(
        'Google Drive ended the change log without a new start page token.',
        { retryable: false, detail: page },
      )
    }

    return {
      nextCursor: page.newStartPageToken,
      scanned,
      inserted,
    }
  }
}

async function releaseAfterFailure(
  repository: IntakeRepository,
  lease: SyncStateLease,
): Promise<void> {
  try {
    await repository.releaseSyncState(lease.key, lease.leaseToken)
  } catch {
    // Preserve the original failure. The database lease has an expiry and will
    // self-heal even if the best-effort early release also lost connectivity.
  }
}

/**
 * Polls Drive under a database lease.
 *
 * First run is race-safe:
 *   T0 → full reconcile → replay T0 → persist the replay's new token.
 * The cursor is completed once, after every discovery succeeds. Any error leaves
 * the old durable value untouched, so an intermediate page token can never
 * rewind or skip the log.
 */
export async function watchRawFolder(
  drive: DriveReader,
  repository: IntakeRepository,
  rawFolderId: string,
): Promise<WatchResult> {
  const lease = await repository.claimSyncState(
    DRIVE_SYNC_STATE_KEY,
    DRIVE_SYNC_LEASE_SECONDS,
  )
  if (!lease) return { mode: 'busy', scanned: 0, inserted: 0 }

  try {
    let mode: WatchResult['mode']
    let scanned = 0
    let inserted = 0
    let replay: ChangeReplayResult

    if (lease.value === null) {
      mode = 'bootstrap'

      // T0 must be obtained BEFORE the full list. A file arriving during the list
      // is then guaranteed to appear in the replay that follows it.
      const t0 = await drive.getStartPageToken()
      const reconciliation = await reconcileRawFolder(drive, repository, rawFolderId)
      scanned += reconciliation.scanned
      inserted += reconciliation.inserted
      replay = await replayChanges(drive, repository, rawFolderId, t0)
    } else {
      mode = 'incremental'
      if (!lease.value.trim()) {
        throw new IntakeRepositoryError(
          'The persisted Google Drive change token is empty.',
          { retryable: false, detail: { key: lease.key } },
        )
      }
      replay = await replayChanges(drive, repository, rawFolderId, lease.value)
    }

    scanned += replay.scanned
    inserted += replay.inserted

    const completed = await repository.completeSyncState(
      lease.key,
      lease.leaseToken,
      replay.nextCursor,
    )
    if (!completed) {
      throw new IntakeRepositoryError(
        'The Drive sync lease expired before its cursor could be advanced.',
        { retryable: true },
      )
    }

    await repository.recordSystemEvent({
      event: 'drive.watch.completed',
      actor: 'cron',
      detail: {
        source: 'watch',
        mode,
        scanned,
        inserted,
      },
    })

    return { mode, scanned, inserted }
  } catch (error) {
    await releaseAfterFailure(repository, lease)
    throw error
  }
}
