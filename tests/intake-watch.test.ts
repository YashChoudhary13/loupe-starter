import { describe, expect, it } from 'vitest'

import { DriveError } from '@/lib/google/drive-errors'
import {
  DRIVE_FOLDER_MIME_TYPE,
  type DriveChange,
  type DriveFileMetadata,
  type DriveReader,
} from '@/lib/google/drive-types'
import { watchRawFolder } from '@/lib/intake/watch'

import { MemoryIntakeRepository } from './helpers/intake'

function file(
  id: string,
  overrides: Partial<DriveFileMetadata> = {},
): DriveFileMetadata {
  return {
    id,
    name: `${id}.jpg`,
    md5Checksum: `md5-${id}`,
    size: '321',
    mimeType: 'image/jpeg',
    parents: ['RAW'],
    trashed: false,
    ...overrides,
  }
}

function change(
  id: string,
  overrides: Partial<DriveChange> = {},
): DriveChange {
  return {
    fileId: id,
    removed: false,
    file: file(id),
    ...overrides,
  }
}

describe('Drive change watch', () => {
  it('bootstraps race-safely: T0, full reconcile, then replay T0, then completes', async () => {
    const order: string[] = []
    const drive: DriveReader = {
      getStartPageToken: async () => {
        order.push('get:T0')
        return 'T0'
      },
      listRawFolderPage: async () => {
        order.push('reconcile')
        return { files: [file('already-there')], nextPageToken: null }
      },
      listChangesPage: async (token) => {
        order.push(`changes:${token}`)
        // This file represents an arrival after T0 but during the full listing.
        return {
          changes: [change('arrived-during-reconcile')],
          nextPageToken: null,
          newStartPageToken: 'T1',
        }
      },
    }
    const repository = new MemoryIntakeRepository()

    await expect(watchRawFolder(drive, repository, 'RAW')).resolves.toEqual({
      mode: 'bootstrap',
      scanned: 2,
      inserted: 2,
    })

    expect(order).toEqual(['get:T0', 'reconcile', 'changes:T0'])
    expect(repository.persistedValue).toBe('T1')
    expect(repository.completedValues).toEqual(['T1'])
    expect(repository.discoveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ driveFileId: 'already-there', source: 'reconcile' }),
        expect.objectContaining({
          driveFileId: 'arrived-during-reconcile',
          source: 'watch',
        }),
      ]),
    )
    expect(repository.events.at(-1)?.event).toBe('drive.watch.completed')
  })

  it('paginates changes and client-filters direct live RAW children', async () => {
    const requestedTokens: string[] = []
    const repository = new MemoryIntakeRepository()
    repository.persistedValue = 'CURSOR-0'

    const drive: DriveReader = {
      getStartPageToken: async () => {
        throw new Error('not used for an existing cursor')
      },
      listRawFolderPage: async () => {
        throw new Error('incremental watch must not reconcile')
      },
      listChangesPage: async (token) => {
        requestedTokens.push(token)
        if (token === 'CURSOR-0') {
          return {
            changes: [
              change('direct'),
              change('removed', { removed: true }),
              change('moved-away', { file: file('moved-away', { parents: ['OTHER'] }) }),
              change('folder', {
                file: file('folder', { mimeType: DRIVE_FOLDER_MIME_TYPE }),
              }),
            ],
            nextPageToken: 'PAGE-2',
            newStartPageToken: null,
          }
        }
        return {
          changes: [change('second-page')],
          nextPageToken: null,
          newStartPageToken: 'CURSOR-1',
        }
      },
    }

    await expect(watchRawFolder(drive, repository, 'RAW')).resolves.toEqual({
      mode: 'incremental',
      scanned: 5,
      inserted: 2,
    })

    expect(requestedTokens).toEqual(['CURSOR-0', 'PAGE-2'])
    expect(repository.fileIds).toEqual(new Set(['direct', 'second-page']))
    expect(repository.completedValues).toEqual(['CURSOR-1'])
  })

  it('never persists an intermediate page token when a later page fails', async () => {
    const repository = new MemoryIntakeRepository()
    repository.persistedValue = 'DURABLE-OLD'

    const drive: DriveReader = {
      getStartPageToken: async () => {
        throw new Error('not used')
      },
      listRawFolderPage: async () => {
        throw new Error('not used')
      },
      listChangesPage: async (token) => {
        if (token === 'DURABLE-OLD') {
          return {
            changes: [change('first-page-file')],
            nextPageToken: 'EPHEMERAL-PAGE-2',
            newStartPageToken: null,
          }
        }
        throw new DriveError('temporary failure', {
          kind: 'server',
          retryable: true,
        })
      },
    }

    await expect(watchRawFolder(drive, repository, 'RAW')).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
    })

    expect(repository.persistedValue).toBe('DURABLE-OLD')
    expect(repository.completedValues).toEqual([])
    expect(repository.releasedTokens).toEqual(['lease-1'])
    // The first insert is safe: replaying DURABLE-OLD will get `inserted=false`.
    expect(repository.fileIds).toEqual(new Set(['first-page-file']))
  })

  it('does no Drive work when another poller holds the lease', async () => {
    const repository = new MemoryIntakeRepository()
    repository.leaseAvailable = false
    let driveCalls = 0
    const drive: DriveReader = {
      getStartPageToken: async () => {
        driveCalls += 1
        return 'unused'
      },
      listRawFolderPage: async () => {
        driveCalls += 1
        return { files: [], nextPageToken: null }
      },
      listChangesPage: async () => {
        driveCalls += 1
        return { changes: [], nextPageToken: null, newStartPageToken: 'unused' }
      },
    }

    await expect(watchRawFolder(drive, repository, 'RAW')).resolves.toEqual({
      mode: 'busy',
      scanned: 0,
      inserted: 0,
    })
    expect(driveCalls).toBe(0)
  })
})
