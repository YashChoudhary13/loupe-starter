/**
 * Step 3 of the colour backfill: write the colours the worker computed.
 *   npx tsx scripts/import-colour.ts runs/colour/colours.jsonl
 * Each line: {"reference_id": "...", "colour": [15 floats]}. Idempotent.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { pgClient } from './lib/pg'

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'runs/colour/colours.jsonl'
  const db = pgClient()
  await db.connect()
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  let n = 0, bad = 0
  for await (const line of rl) {
    if (!line.trim()) continue
    const { reference_id, colour } = JSON.parse(line) as { reference_id: string; colour: number[] }
    if (!Array.isArray(colour) || colour.length !== 15) { bad += 1; continue }
    await db.query(`select public.set_reference_colour($1, $2)`, [reference_id, `[${colour.map((x) => Number(x).toFixed(6)).join(',')}]`])
    n += 1
    if (n % 200 === 0) console.log(`  ${n}…`)
  }
  await db.end()
  console.log(`set colour on ${n} reference(s)${bad ? `; skipped ${bad} malformed` : ''}`)
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
