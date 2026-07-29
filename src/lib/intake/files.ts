import {
  DRIVE_FOLDER_MIME_TYPE,
  type DriveFileMetadata,
} from '@/lib/google/drive-types'
import { DriveError } from '@/lib/google/drive-errors'

import {
  type IntakeDiscoverySource,
  type IntakeRepository,
} from './repository'

export const DISCOVERY_CONCURRENCY = 10

function parseBytes(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DriveError('Google Drive returned an invalid file size.', {
      kind: 'malformed_response',
      retryable: false,
      detail: value,
    })
  }
  return parsed
}

/** True only for a live, non-folder file whose immediate parent is RAW. */
export function isDirectRawChild(
  file: DriveFileMetadata,
  rawFolderId: string,
): boolean {
  return (
    !file.trashed &&
    file.mimeType !== DRIVE_FOLDER_MIME_TYPE &&
    file.parents.includes(rawFolderId)
  )
}

/**
 * Records a page with bounded concurrency and counts only database insertions.
 *
 * Replays can contain the same file more than once. The database's UNIQUE Drive
 * id and `inserted` return flag are the authority; attempted RPCs are not counted
 * as discoveries.
 */
export async function discoverFiles(
  repository: IntakeRepository,
  files: readonly DriveFileMetadata[],
  rawFolderId: string,
  source: IntakeDiscoverySource,
): Promise<{ readonly scanned: number; readonly inserted: number }> {
  const candidates = files.filter((file) => isDirectRawChild(file, rawFolderId))
  let nextIndex = 0
  let inserted = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const index = nextIndex
      nextIndex += 1
      const file = candidates[index]
      if (!file) continue

      const result = await repository.discoverIntakeFile({
        driveFileId: file.id,
        filename: file.name,
        driveMd5: file.md5Checksum,
        bytes: parseBytes(file.size),
        mimeType: file.mimeType,
        source,
      })
      if (result.inserted) inserted += 1
    }
  }

  const workers = Array.from(
    { length: Math.min(DISCOVERY_CONCURRENCY, candidates.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return { scanned: candidates.length, inserted }
}
