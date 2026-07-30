/**
 * Phase 4 · criterion 14 — moving a published photograph into Drive /Processed.
 *
 * Drive has no `move`: a file's location IS its `parents` list, so the move is
 * "add the target, remove whatever it is in now" in one update. Two properties
 * matter more than the happy path:
 *
 *   idempotent  a retry on an already-moved file must not fail. Drive rejects a
 *               `removeParents` naming a folder the file is not in, so a naive
 *               second attempt errors for no reason at all — and an error here
 *               would be recorded against a product that is perfectly fine.
 *   harmless    it is housekeeping (hard rule 3). Nothing reads folder membership
 *               to decide what has been processed.
 */
import type { drive_v3 } from '@googleapis/drive'
import { describe, expect, it } from 'vitest'

import { type DriveApiExecutor, GoogleDriveClient } from '@/lib/google/drive-client'
import { DriveError } from '@/lib/google/drive-errors'

const RAW = 'raw-folder-id'
const PROCESSED = 'processed-folder-id'

function harness(
  file: drive_v3.Schema$File,
  onUpdate?: (params: drive_v3.Params$Resource$Files$Update) => drive_v3.Schema$File,
) {
  const updates: drive_v3.Params$Resource$Files$Update[] = []
  const gets: drive_v3.Params$Resource$Files$Get[] = []

  const api: DriveApiExecutor = {
    getStartPageToken: async () => ({ startPageToken: 'unused' }),
    listFiles: async () => ({ files: [] }),
    listChanges: async () => ({ changes: [] }),
    downloadFile: async () => new ArrayBuffer(0),
    getFile: async (params) => {
      gets.push(params)
      return file
    },
    updateFile: async (params) => {
      updates.push(params)
      return onUpdate ? onUpdate(params) : { id: params.fileId, parents: [PROCESSED] }
    },
  }

  return { client: new GoogleDriveClient(api), updates, gets }
}

describe('moveToFolder', () => {
  it('moves a file out of Raw and into Processed in one update', async () => {
    const { client, updates, gets } = harness({ id: 'file-1', parents: [RAW] })

    const outcome = await client.moveToFolder('file-1', PROCESSED)

    expect(outcome).toEqual({ fileId: 'file-1', moved: true, parents: [PROCESSED] })
    expect(gets[0].fields).toContain('parents')
    expect(updates).toHaveLength(1)
    expect(updates[0].addParents).toBe(PROCESSED)
    expect(updates[0].removeParents).toBe(RAW)
    // Shared Drives are a supported fixture path (D32), so every call says so.
    expect(updates[0].supportsAllDrives).toBe(true)
  })

  it('IS IDEMPOTENT — a file already in Processed is left alone', async () => {
    const { client, updates } = harness({ id: 'file-1', parents: [PROCESSED] })

    const outcome = await client.moveToFolder('file-1', PROCESSED)

    // `moved: false` is a successful repeat, not a failure. Retrying housekeeping
    // must never report a problem against a product that is perfectly published.
    expect(outcome.moved).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('removes only the OTHER parents when a file sits in several folders', async () => {
    const { client, updates } = harness({ id: 'file-1', parents: [RAW, 'someone-else', PROCESSED] })

    await client.moveToFolder('file-1', PROCESSED)

    // Already in the target, so nothing is added — adding a parent it already has
    // is what Drive rejects.
    expect(updates[0].addParents).toBeUndefined()
    expect(updates[0].removeParents).toBe(`${RAW},someone-else`)
  })

  it('classifies a Drive failure rather than leaking the raw client error', async () => {
    const api: DriveApiExecutor = {
      getStartPageToken: async () => ({ startPageToken: 'unused' }),
      listFiles: async () => ({ files: [] }),
      listChanges: async () => ({ changes: [] }),
      downloadFile: async () => new ArrayBuffer(0),
      getFile: async () => ({ id: 'file-1', parents: [RAW] }),
      updateFile: async () => {
        throw Object.assign(new Error('insufficient permissions'), { status: 403 })
      },
    }

    await expect(new GoogleDriveClient(api).moveToFolder('file-1', PROCESSED)).rejects.toBeInstanceOf(
      DriveError,
    )
  })

  it('refuses an empty file or folder id before making a request', async () => {
    const { client, gets, updates } = harness({ id: 'file-1', parents: [RAW] })
    await expect(client.moveToFolder('', PROCESSED)).rejects.toBeInstanceOf(DriveError)
    await expect(client.moveToFolder('file-1', '  ')).rejects.toBeInstanceOf(DriveError)
    expect(gets).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })
})
