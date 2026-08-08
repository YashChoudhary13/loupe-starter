/**
 * The RAW-folder sweep.
 *
 * Drive housekeeping only ever ran on the console's publish path. Qimati does
 * not publish from the console — reconciliation promotes drafts published in
 * Shopify admin, and that path never tidied Drive. Measured 2026-08-08: 49
 * drive-sourced photographs at `published` with `drive_processed_at` null and
 * zero housekeeping events ever recorded. See D92.
 */
import { describe, expect, it, vi } from 'vitest'

import { tidyPublishedDriveBacklog } from '@/lib/console/drive-backlog'

interface Row {
  id: string
  filename: string
  drive_file_id: string
}

/**
 * A Supabase query-builder stub that records the filters it was given, so the
 * test can assert on WHICH rows were asked for — the part that decides whether
 * an unpublished photograph is dragged out of RAW too early.
 */
function dbStub(rows: Row[]) {
  const filters: Record<string, unknown> = {}
  const rpc = vi.fn().mockResolvedValue({ error: null })
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters[column] = value
      return builder
    },
    is: (column: string, value: unknown) => {
      filters[`${column}:is`] = value
      return builder
    },
    order: () => builder,
    limit: (n: number) => {
      filters.limit = n
      return Promise.resolve({ data: rows.slice(0, n), error: null })
    },
  }
  return { db: { from: () => builder, rpc } as never, filters, rpc }
}

const row = (n: number): Row => ({
  id: `intake-${n}`,
  filename: `IMG_${n}.jpg`,
  drive_file_id: `drive-${n}`,
})

const drive = (impl?: (id: string) => Promise<{ moved: boolean }>) => ({
  moveToFolder: vi.fn(impl ?? (async () => ({ moved: true }))),
})

describe('tidyPublishedDriveBacklog', () => {
  it('asks only for published, drive-sourced photographs that were never moved', async () => {
    const { db, filters } = dbStub([])
    await tidyPublishedDriveBacklog({
      db,
      drive: drive() as never,
      processedFolderId: 'folder-processed',
      actor: 'test',
    })

    // Published is the only state that means "done". A grouped-but-unpublished
    // photograph belongs to a draft that may still change.
    expect(filters.status).toBe('published')
    // `manual:<uuid>` uploads never entered Drive; moveToFolder would 404.
    expect(filters.source).toBe('drive')
    expect(filters['drive_processed_at:is']).toBeNull()
  })

  it('moves each file and records the housekeeping against its intake row', async () => {
    const { db, rpc } = dbStub([row(1), row(2)])
    const client = drive()

    const result = await tidyPublishedDriveBacklog({
      db,
      drive: client as never,
      processedFolderId: 'folder-processed',
      actor: 'operator@qimati.in',
    })

    expect(result).toMatchObject({ considered: 2, moved: 2, failed: 0, more: false })
    expect(client.moveToFolder.mock.calls).toEqual([
      ['drive-1', 'folder-processed'],
      ['drive-2', 'folder-processed'],
    ])
    expect(rpc).toHaveBeenCalledWith('record_drive_housekeeping', {
      p_intake_file_id: 'intake-1',
      p_ok: true,
      p_error: null,
      p_actor: 'operator@qimati.in',
    })
  })

  it('keeps going when one file fails, and records the reason against that file', async () => {
    // A single file trashed by hand, or one revoked permission, must not strand
    // the rest of the backlog behind it.
    const { db, rpc } = dbStub([row(1), row(2), row(3)])
    const client = drive(async (id) => {
      if (id === 'drive-2') throw new Error('File not found: drive-2')
      return { moved: true }
    })

    const result = await tidyPublishedDriveBacklog({
      db,
      drive: client as never,
      processedFolderId: 'folder-processed',
      actor: 'test',
    })

    expect(result).toMatchObject({ considered: 3, moved: 2, failed: 1 })
    expect(client.moveToFolder).toHaveBeenCalledTimes(3)
    expect(rpc).toHaveBeenCalledWith('record_drive_housekeeping', {
      p_intake_file_id: 'intake-2',
      p_ok: false,
      p_error: 'File not found: drive-2',
      p_actor: 'test',
    })
  })

  it('reports a file already in /Processed as a success that moved nothing', async () => {
    // Re-running the sweep must be safe. moveToFolder is the one that knows.
    const { db } = dbStub([row(1)])
    const result = await tidyPublishedDriveBacklog({
      db,
      drive: drive(async () => ({ moved: false })) as never,
      processedFolderId: 'folder-processed',
      actor: 'test',
    })
    expect(result.moved).toBe(1)
    expect(result.outcomes[0]).toMatchObject({ ok: true, moved: false })
  })

  it('bounds one run and says so, instead of quietly truncating', async () => {
    // A cron request has a time limit. Silence here would read as "RAW is clear".
    const { db } = dbStub([row(1), row(2), row(3), row(4)])
    const result = await tidyPublishedDriveBacklog({
      db,
      drive: drive() as never,
      processedFolderId: 'folder-processed',
      actor: 'test',
      limit: 2,
    })
    expect(result).toMatchObject({ considered: 2, moved: 2, more: true })
  })

  it('does nothing at all when RAW holds no published photographs', async () => {
    const { db } = dbStub([])
    const client = drive()
    const result = await tidyPublishedDriveBacklog({
      db,
      drive: client as never,
      processedFolderId: 'folder-processed',
      actor: 'test',
    })
    expect(result).toMatchObject({ considered: 0, moved: 0, more: false })
    expect(client.moveToFolder).not.toHaveBeenCalled()
  })
})
