/**
 * Phase 4 · criterion 14 — a forced Drive failure must not undo a publication.
 *
 * This is the test the criterion is really about. The happy path is easy to
 * believe; what has to be proved is that when Drive says no, the product is still
 * live, the intake rows are still `published`, one bad file does not take the
 * others down with it, and an operator can read what went wrong.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { tidyDriveForDraft } from '@/lib/console/housekeeping'
import type { DriveHousekeeper, DriveMoveOutcome } from '@/lib/google/drive-types'

interface Row {
  id: string
  filename: string
  drive_file_id: string
  source: 'drive' | 'manual'
  status: string
  drive_processed_at: string | null
}

interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

/**
 * A Supabase double that answers exactly the two things this module asks of it:
 * the draft's published photographs, and `record_drive_housekeeping`.
 */
function fakeDb(rows: Row[]) {
  const rpcCalls: RpcCall[] = []
  const filters: Record<string, unknown> = {}

  const db = {
    from() {
      const builder = {
        select() {
          return builder
        },
        eq(column: string, value: unknown) {
          filters[column] = value
          // The module must only ever ask for rows the database already says are
          // published — tidying before the state is safe is the ordering bug.
          return builder
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          const matching = rows.filter((row) =>
            Object.entries(filters).every(([column, value]) =>
              column === 'product_draft_id' ? true : (row as unknown as Record<string, unknown>)[column] === value,
            ),
          )
          return Promise.resolve(resolve({ data: matching, error: null }))
        },
      }
      return builder
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      return { data: null, error: null }
    },
  }

  return { db: db as unknown as SupabaseClient, rpcCalls, filters }
}

function drive(behaviour: (fileId: string) => DriveMoveOutcome | Error): DriveHousekeeper {
  return {
    async moveToFolder(fileId: string): Promise<DriveMoveOutcome> {
      const result = behaviour(fileId)
      if (result instanceof Error) throw result
      return result
    },
  }
}

const rows: Row[] = [
  { id: 'intake-1', filename: 'one.png', drive_file_id: 'drive-1', source: 'drive', status: 'published', drive_processed_at: null },
  { id: 'intake-2', filename: 'two.png', drive_file_id: 'drive-2', source: 'drive', status: 'published', drive_processed_at: null },
  { id: 'intake-3', filename: 'three.png', drive_file_id: 'drive-3', source: 'drive', status: 'published', drive_processed_at: null },
]

const DEPS = { processedFolderId: 'processed-folder', actor: 'operator@example.com' }

describe('post-publish Drive housekeeping', () => {
  it('only ever looks at photographs the database already calls published', async () => {
    const { db, filters } = fakeDb(rows)
    await tidyDriveForDraft('draft-1', {
      db,
      drive: drive((fileId) => ({ fileId, moved: true, parents: ['processed-folder'] })),
      ...DEPS,
    })
    expect(filters.status).toBe('published')
    expect(filters.source).toBe('drive')
    expect(filters.product_draft_id).toBe('draft-1')
  })

  it('never sends a manual ready-image identity to Google Drive', async () => {
    const manual: Row = {
      id: 'manual-intake',
      filename: 'ready.jpg',
      drive_file_id: 'manual:upload-id',
      source: 'manual',
      status: 'published',
      drive_processed_at: null,
    }
    const { db, rpcCalls } = fakeDb([...rows, manual])
    const moved: string[] = []
    const outcomes = await tidyDriveForDraft('draft-1', {
      db,
      drive: drive((fileId) => {
        moved.push(fileId)
        return { fileId, moved: true, parents: ['processed-folder'] }
      }),
      ...DEPS,
    })

    expect(moved).toEqual(['drive-1', 'drive-2', 'drive-3'])
    expect(outcomes).toHaveLength(3)
    expect(rpcCalls).toHaveLength(3)
  })

  it('moves each file and records the success', async () => {
    const { db, rpcCalls } = fakeDb(rows)
    const outcomes = await tidyDriveForDraft('draft-1', {
      db,
      drive: drive((fileId) => ({ fileId, moved: true, parents: ['processed-folder'] })),
      ...DEPS,
    })

    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true])
    expect(rpcCalls).toHaveLength(3)
    expect(rpcCalls.every((c) => c.fn === 'record_drive_housekeeping')).toBe(true)
    expect(rpcCalls[0].args.p_ok).toBe(true)
    expect(rpcCalls[0].args.p_actor).toBe('operator@example.com')
  })

  it('reports an already-moved file as a safe repeat, not a failure', async () => {
    const { db } = fakeDb(rows)
    const outcomes = await tidyDriveForDraft('draft-1', {
      db,
      drive: drive((fileId) => ({ fileId, moved: false, parents: ['processed-folder'] })),
      ...DEPS,
    })
    expect(outcomes.every((o) => o.ok && !o.moved)).toBe(true)
  })

  it('A FORCED FAILURE does not stop the other files and does not throw', async () => {
    const { db, rpcCalls } = fakeDb(rows)

    const outcomes = await tidyDriveForDraft('draft-1', {
      db,
      drive: drive((fileId) =>
        fileId === 'drive-2'
          ? new Error('Google Drive refused the move: 403 insufficient permissions')
          : { fileId, moved: true, parents: ['processed-folder'] },
      ),
      ...DEPS,
    })

    // The publish is already done. Housekeeping reports; it never throws, because
    // throwing here would surface as "the publish failed" for a product that is
    // live in the store.
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true])
    expect(outcomes[1].error).toMatch(/403/)
    expect(outcomes[1].filename).toBe('two.png')

    // The failure is recorded where a human can find it, and the two successes
    // are recorded too — one bad file does not cost the others their tidy-up.
    const failed = rpcCalls.filter((c) => c.args.p_ok === false)
    expect(failed).toHaveLength(1)
    expect(failed[0].args.p_intake_file_id).toBe('intake-2')
    expect(String(failed[0].args.p_error)).toMatch(/insufficient permissions/)
    expect(rpcCalls.filter((c) => c.args.p_ok === true)).toHaveLength(2)
  })

  it('records a failure for every file when Drive is entirely unavailable', async () => {
    const { db, rpcCalls } = fakeDb(rows)
    const outcomes = await tidyDriveForDraft('draft-1', {
      db,
      drive: drive(() => new Error('getaddrinfo ENOTFOUND www.googleapis.com')),
      ...DEPS,
    })

    expect(outcomes.every((o) => !o.ok)).toBe(true)
    expect(rpcCalls.filter((c) => c.args.p_ok === false)).toHaveLength(3)
  })

  it('does nothing at all for a draft with no published photographs', async () => {
    const { db, rpcCalls } = fakeDb([])
    let moves = 0
    const outcomes = await tidyDriveForDraft('draft-1', {
      db,
      drive: {
        async moveToFolder(fileId) {
          moves += 1
          return { fileId, moved: true, parents: [] }
        },
      },
      ...DEPS,
    })
    expect(outcomes).toEqual([])
    expect(moves).toBe(0)
    expect(rpcCalls).toHaveLength(0)
  })
})
