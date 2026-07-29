import { describe, expect, it } from 'vitest'

import {
  DRIVE_FOLDER_MIME_TYPE,
  type DriveFileMetadata,
  type DriveReader,
} from '@/lib/google/drive-types'
import { runReconcileJob } from '@/lib/intake/reconcile'

import { MemoryIntakeRepository } from './helpers/intake'

function file(
  id: string,
  overrides: Partial<DriveFileMetadata> = {},
): DriveFileMetadata {
  return {
    id,
    name: `${id}.jpg`,
    md5Checksum: `md5-${id}`,
    size: '123',
    mimeType: 'image/jpeg',
    parents: ['RAW'],
    trashed: false,
    ...overrides,
  }
}

describe('RAW reconciliation', () => {
  it('paginates, excludes folders/non-children/trash, and is idempotent by RPC result', async () => {
    const requestedTokens: Array<string | undefined> = []
    const drive: DriveReader = {
      getStartPageToken: async () => {
        throw new Error('not used')
      },
      listChangesPage: async () => {
        throw new Error('not used')
      },
      listRawFolderPage: async (_rawFolderId, pageToken) => {
        requestedTokens.push(pageToken)
        if (!pageToken) {
          return {
            files: [
              file('one'),
              file('folder', { mimeType: DRIVE_FOLDER_MIME_TYPE }),
              file('outside', { parents: ['OTHER'] }),
              file('trashed', { trashed: true }),
            ],
            nextPageToken: 'PAGE-2',
          }
        }
        return {
          files: [file('two')],
          nextPageToken: null,
        }
      },
    }
    const repository = new MemoryIntakeRepository()

    await expect(runReconcileJob(drive, repository, 'RAW')).resolves.toEqual({
      scanned: 2,
      inserted: 2,
    })
    await expect(runReconcileJob(drive, repository, 'RAW')).resolves.toEqual({
      scanned: 2,
      inserted: 0,
    })

    expect(requestedTokens).toEqual([undefined, 'PAGE-2', undefined, 'PAGE-2'])
    expect(repository.fileIds).toEqual(new Set(['one', 'two']))
    expect(repository.discoveries).toHaveLength(4)
    expect(repository.discoveries.every((item) => item.source === 'reconcile')).toBe(true)
    expect(repository.events.map((event) => event.event)).toEqual([
      'drive.reconcile.completed',
      'drive.reconcile.completed',
    ])
  })
})
