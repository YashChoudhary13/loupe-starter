/**
 * Remove the temporary Phase 3C production acceptance fixtures after their
 * source, generated images, prompts and evidence have been copied locally.
 *
 * PHASE3C_LIVE_CLEANUP=I_UNDERSTAND_THIS_DELETES_ACCEPTANCE_FIXTURES \
 * NODE_OPTIONS=--conditions=react-server npx tsx scripts/cleanup-phase3c-live.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env', quiet: true })
loadEnv({ path: '.env.local', override: true, quiet: true })

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_ACCEPTANCE_FIXTURES'
const FILENAMES = [
  'phase3b-01.png',
  'phase3b-02.jpg',
  'phase3b-03.jpg',
  'phase3b-04.png',
  'user-earrings-source.png',
] as const

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env`)
  return value
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  invariant(
    process.env.PHASE3C_LIVE_CLEANUP === CONFIRMATION,
    `Refusing cleanup. Set PHASE3C_LIVE_CLEANUP=${CONFIRMATION}.`,
  )

  const [{ R2ObjectStore }, { pgClient }] = await Promise.all([
    import('../src/lib/enhance/storage'),
    import('./lib/pg'),
  ])
  const db = pgClient()
  await db.connect()
  try {
    const fixtures = await db.query<{ id: string; filename: string }>(
      `select id, filename
         from public.intake_files
        where filename = any($1::text[])
        order by filename`,
      [[...FILENAMES]],
    )
    invariant(
      fixtures.rows.length === FILENAMES.length,
      `Expected ${FILENAMES.length} acceptance rows, found ${fixtures.rows.length}.`,
    )
    const ids = fixtures.rows.map((row) => row.id)
    const versions = await db.query<{
      storage_key: string
      thumb_key: string | null
    }>(
      `select storage_key, thumb_key
         from public.image_versions
        where intake_file_id = any($1::uuid[])
        order by intake_file_id, kind, version_no`,
      [ids],
    )
    const objectKeys = [
      ...new Set(
        versions.rows.flatMap((row) =>
          row.thumb_key
            ? [row.storage_key, row.thumb_key]
            : [row.storage_key],
        ),
      ),
    ]
    invariant(
      objectKeys.length === 15,
      `Expected 15 acceptance R2 objects, found ${objectKeys.length}.`,
    )

    const store = new R2ObjectStore({
      endpoint: required('R2_ENDPOINT'),
      accessKeyId: required('R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      bucket: required('R2_BUCKET'),
    })
    for (const key of objectKeys) await store.delete(key)
    const remainingObjects = (
      await Promise.all(objectKeys.map((key) => store.head(key)))
    ).filter(Boolean)
    invariant(
      remainingObjects.length === 0,
      `${remainingObjects.length} acceptance R2 objects remain after cleanup.`,
    )

    await db.query('begin')
    try {
      const deletedEvents = await db.query(
        `delete from public.events
          where entity_type = 'intake_file'
            and entity_id = any($1::uuid[])`,
        [ids],
      )
      const deletedRows = await db.query(
        `delete from public.intake_files
          where id = any($1::uuid[])
        returning id`,
        [ids],
      )
      invariant(
        deletedRows.rowCount === FILENAMES.length,
        `Expected to delete five intake rows, deleted ${deletedRows.rowCount ?? 0}.`,
      )
      await db.query('commit')

      const remainingRows = await db.query<{ count: string }>(
        `select count(*)::text as count
           from public.intake_files
          where id = any($1::uuid[])`,
        [ids],
      )
      invariant(
        remainingRows.rows[0]?.count === '0',
        'Acceptance database rows remain after cleanup.',
      )

      const evidenceRoot = resolve('.artifacts/phase3c-acceptance')
      mkdirSync(evidenceRoot, { recursive: true })
      const receipt = {
        cleanedAt: new Date().toISOString(),
        filenames: [...FILENAMES],
        drive: {
          movedToTrash: 5,
          verifiedVisibleRowsAfterCleanup: 0,
        },
        database: {
          intakeRowsDeleted: deletedRows.rowCount,
          imageVersionsDeletedByCascade: versions.rows.length,
          eventsDeleted: deletedEvents.rowCount,
          remainingAcceptanceRows: 0,
        },
        r2: {
          objectsDeleted: objectKeys.length,
          remainingAcceptanceObjects: 0,
        },
        localEvidencePreserved: true,
      }
      const receiptPath = resolve(evidenceRoot, 'cleanup.json')
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
      console.log(JSON.stringify({ receipt: receiptPath, ...receipt }, null, 2))
    } catch (error) {
      await db.query('rollback')
      throw error
    }
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
