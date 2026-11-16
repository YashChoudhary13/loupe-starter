/**
 * Find (D173): rebuild the link from a delivered image to the phone photograph it was made from, for the deliveries
 * that lost it (708 of 1,101 on 2026-11-14, see the D170 repair migration). Find shows a product's raw photograph
 * through that link, so a delivery without it has no raw photograph to show.
 *
 * The database never stored the source file name, but the enhancer's receipts did: every `loupe-push.json` lists, per
 * delivery, the phone file name and the intake id Loupe answered with. A link is written only when the delivery has
 * none, and exactly one uploaded photograph of the delivery's own batch carries that file name.
 *
 *   npx tsx scripts/backfill-raw-photo-links.ts <folder holding receipts> [--apply]
 *
 * Without --apply nothing changes; it prints what it would do. It writes to the live database, so run it from a
 * checkout with `.env`, once per place receipts live (the Mac's ~/Downloads, the Canada server's ~/agent-batches).
 * Running it again is safe: a delivery that has a link is left alone.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { pgClient } from './lib/pg'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Every loupe-push.json at most five folders down; build and dot folders are skipped. */
function receiptsUnder(folder: string, depth = 0): string[] {
  const found: string[] = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'loupe-push.json') found.push(join(folder, entry.name))
    else if (entry.isDirectory() && depth < 5 && !entry.name.startsWith('.') && entry.name !== 'node_modules') found.push(...receiptsUnder(join(folder, entry.name), depth + 1))
  }
  return found
}

/** intake id → phone file name, from one receipt. A file that is not a receipt is skipped, not fatal. */
function deliveriesIn(file: string): [string, string][] {
  try {
    const items: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(items)) return []
    return items.flatMap((item: { photo?: unknown; result?: { intake_id?: unknown } }) =>
      typeof item?.photo === 'string' && typeof item.result?.intake_id === 'string' && UUID.test(item.result.intake_id) ? [[item.result.intake_id.toLowerCase(), basename(item.photo)] as [string, string]] : [])
  } catch { return [] }
}

/** One row per delivery named by a receipt: whether Loupe still has it, whether it is linked, and the photographs of its batch with that file name. */
const CANDIDATES_SQL = `
  select w.intake_id, f.id is not null as known, f.agent_source_photo_id is not null as linked,
         coalesce((select array_agg(p.id) from public.agent_jobs j join public.agent_job_photos p on p.job_id = j.id
                    where j.label = f.agent_batch and p.filename = w.filename and p.status = 'uploaded'), '{}') as photos
    from unnest($1::uuid[], $2::text[]) as w(intake_id, filename)
    left join public.intake_files f on f.id = w.intake_id`

async function main() {
  const [folder, flag] = process.argv.slice(2)
  if (!folder || (flag && flag !== '--apply')) throw new Error('Usage: npx tsx scripts/backfill-raw-photo-links.ts <folder holding receipts> [--apply]')
  const receipts = receiptsUnder(folder)
  const wanted = new Map(receipts.flatMap(deliveriesIn))
  console.log(`${receipts.length} receipt(s), ${wanted.size} delivery(ies) named in them`)
  if (!wanted.size) return

  const db = pgClient()
  await db.connect()
  try {
    const rows = (await db.query<{ intake_id: string; known: boolean; linked: boolean; photos: string[] }>(CANDIDATES_SQL, [[...wanted.keys()], [...wanted.values()]])).rows
    const link = rows.filter(row => row.known && !row.linked && row.photos.length === 1)
    console.log(`  already linked:                      ${rows.filter(row => row.linked).length}`)
    console.log(`  no longer in Loupe:                  ${rows.filter(row => !row.known).length}`)
    console.log(`  no phone photo with that file name:  ${rows.filter(row => row.known && !row.linked && row.photos.length === 0).length}`)
    console.log(`  several photos with that file name:  ${rows.filter(row => row.known && !row.linked && row.photos.length > 1).length}`)
    console.log(`  to link:                             ${link.length}`)
    if (flag !== '--apply') { console.log('Nothing changed. Add --apply to write the links.'); return }
    await db.query('begin')
    let written = 0
    for (const row of link) written += (await db.query('update public.intake_files set agent_source_photo_id = $2 where id = $1 and agent_source_photo_id is null', [row.intake_id, row.photos[0]])).rowCount ?? 0
    await db.query('commit')
    console.log(`Linked ${written} delivery(ies).`)
  } catch (cause) {
    await db.query('rollback').catch(() => undefined)
    throw cause
  } finally {
    await db.end()
  }
}

main().catch(cause => { console.error(String(cause instanceof Error ? cause.message : cause).slice(0, 400)); process.exit(1) })
