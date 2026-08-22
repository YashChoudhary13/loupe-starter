/**
 * Queue a `sync` job for every Loupe reference that some machine has already
 * fetched and embedded (status synced/indexed, source other than catalogue), so
 * a new worker — the laptop, after the interim Mac run — gets its own copy of
 * the originals. Sync completion keeps an indexed reference indexed
 * (migration 20260822070000), so this never re-embeds anything.
 *
 *   npm run match:resync             # dry run: counts only
 *   npm run match:resync -- --apply
 */
import { pgClient } from './lib/pg'

const apply = process.argv.includes('--apply')

const WHERE = `r.source <> 'catalogue' and r.retired_at is null and r.status in ('synced', 'indexed')
  and not exists (
    select 1 from public.match_jobs j
     where j.reference_id = r.id and j.kind = 'sync' and j.status in ('queued', 'claimed'))`

async function main(): Promise<void> {
  const db = pgClient()
  await db.connect()
  try {
    const { rows } = await db.query<{ n: string }>(`select count(*) as n from public.match_references r where ${WHERE}`)
    console.log(`${rows[0]!.n} reference(s) would get a sync job${apply ? '' : ' (dry run; pass --apply)'}`)
    if (!apply) return
    const inserted = await db.query(
      `insert into public.match_jobs (kind, reference_id) select 'sync', r.id from public.match_references r where ${WHERE}`,
    )
    console.log(`queued ${inserted.rowCount} sync job(s)`)
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
