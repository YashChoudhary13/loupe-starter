/**
 * Imports catalogue reference embeddings (JSONL from
 * AI-Python/loupe-audit/export_catalogue_embeddings.py) as index version
 * bakeoff-v9: one match_references row per catalogue image (source
 * 'catalogue', already indexed) and two match_embeddings rows (full, crop).
 *
 *   npx tsx scripts/import-catalogue-embeddings.ts <file.jsonl> [--version bakeoff-v9]
 *
 * Idempotent on image_url: re-running updates sku/handle/title and vectors.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { pgClient } from './lib/pg'

interface Line {
  sku: string
  handle: string
  title: string | null
  image_url: string
  filename: string
  full: number[]
  crop: number[]
}

const file = process.argv[2]
const versionFlag = process.argv.indexOf('--version')
const version = versionFlag > 0 ? process.argv[versionFlag + 1]! : 'bakeoff-v9'
if (!file) {
  console.error('usage: npx tsx scripts/import-catalogue-embeddings.ts <file.jsonl> [--version name]')
  process.exit(1)
}

const literal = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`

async function main(): Promise<void> {
  const client = pgClient()
  await client.connect()
  let rows = 0
  let batch: Line[] = []

  async function flush(): Promise<void> {
    if (batch.length === 0) return
    await client.query('begin')
    try {
      for (const line of batch) {
        const ref = await client.query<{ id: string }>(
          `insert into public.match_references (sku, handle, title, image_url, source, status, indexed_at, embedded_at, index_version, added_by)
           values ($1, $2, $3, $4, 'catalogue', 'indexed', now(), now(), $5, $6)
           on conflict (image_url) where image_url is not null do update
             set sku = excluded.sku, handle = excluded.handle, title = excluded.title,
                 status = 'indexed', indexed_at = now(), index_version = excluded.index_version, retired_at = null
           returning id`,
          [line.sku, line.handle, line.title, line.image_url, version, `import:${version}`],
        )
        const id = ref.rows[0]!.id
        await client.query(
          `insert into public.match_embeddings (reference_id, view, embedding, model)
           values ($1, 'full', $2::extensions.vector(1152), $4), ($1, 'crop', $3::extensions.vector(1152), $4)
           on conflict (reference_id, view) do update set embedding = excluded.embedding, model = excluded.model, created_at = now()`,
          [id, literal(line.full), literal(line.crop), 'siglip2-so400m-512'],
        )
      }
      await client.query('commit')
      rows += batch.length
      process.stdout.write(`  ${rows} rows\r`)
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
    batch = []
  }

  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const raw of lines) {
      if (!raw.trim()) continue
      const line = JSON.parse(raw) as Line
      if (line.full.length !== 1152 || line.crop.length !== 1152) {
        throw new Error(`${line.filename}: expected 1152-d vectors`)
      }
      batch.push(line)
      if (batch.length >= 100) await flush()
    }
    await flush()

    const summary = await client.query<{ refs: string; vectors: string; skus: string }>(
      `select (select count(*) from public.match_references where source = 'catalogue' and index_version = $1) as refs,
              (select count(*) from public.match_embeddings e join public.match_references r on r.id = e.reference_id where r.source = 'catalogue') as vectors,
              (select count(distinct sku) from public.match_references where source = 'catalogue') as skus`,
      [version],
    )
    console.log(`\nimported ${rows} images as ${version}: ${summary.rows[0]!.refs} references, ${summary.rows[0]!.vectors} vectors, ${summary.rows[0]!.skus} SKUs`)

    // Self-check: a stored vector must find its own SKU at rank 1 with score ~1.
    const probe = await client.query<{ sku: string; literal: string }>(
      `select r.sku, e.embedding::text as literal from public.match_embeddings e join public.match_references r on r.id = e.reference_id
        where r.source = 'catalogue' order by random() limit 1`,
    )
    const hit = await client.query<{ sku: string; score: number }>(
      `select sku, score from public.match_search($1, 3)`, [probe.rows[0]!.literal])
    console.log(`self-search ${probe.rows[0]!.sku} → ${hit.rows.map((r) => `${r.sku}:${Number(r.score).toFixed(3)}`).join(', ')}`)
    if (hit.rows[0]?.sku !== probe.rows[0]!.sku) throw new Error('self-search did not return the stored SKU at rank 1')
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(`\nimport failed\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
