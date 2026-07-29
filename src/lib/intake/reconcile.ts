import type { DriveReader } from '@/lib/google/drive-types'

import { discoverFiles } from './files'
import {
  type IntakeRepository,
  IntakeRepositoryError,
} from './repository'

export interface ReconcileResult {
  readonly scanned: number
  readonly inserted: number
}

/** Full, pagination-safe RAW scan. It never uses modified time and never moves a file. */
export async function reconcileRawFolder(
  drive: DriveReader,
  repository: IntakeRepository,
  rawFolderId: string,
): Promise<ReconcileResult> {
  let pageToken: string | undefined
  const seenTokens = new Set<string>()
  let scanned = 0
  let inserted = 0

  do {
    const page = await drive.listRawFolderPage(rawFolderId, pageToken)
    const pageResult = await discoverFiles(
      repository,
      page.files,
      rawFolderId,
      'reconcile',
    )
    scanned += pageResult.scanned
    inserted += pageResult.inserted

    const next = page.nextPageToken ?? undefined
    if (next) {
      if (seenTokens.has(next)) {
        throw new IntakeRepositoryError(
          'Google Drive repeated a RAW-folder page token; reconciliation stopped safely.',
          { retryable: false, detail: { pageToken: next } },
        )
      }
      seenTokens.add(next)
    }
    pageToken = next
  } while (pageToken)

  return { scanned, inserted }
}

export async function runReconcileJob(
  drive: DriveReader,
  repository: IntakeRepository,
  rawFolderId: string,
): Promise<ReconcileResult> {
  const result = await reconcileRawFolder(drive, repository, rawFolderId)
  await repository.recordSystemEvent({
    event: 'drive.reconcile.completed',
    actor: 'cron',
    detail: {
      source: 'reconcile',
      scanned: result.scanned,
      inserted: result.inserted,
    },
  })
  return result
}
