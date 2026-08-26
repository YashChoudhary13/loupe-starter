/**
 * Step 1 of the colour backfill: list every indexed reference that has no colour
 * signature yet, with a URL the colour worker can fetch — the public catalogue
 * image, or a short-lived presigned GET for a Loupe original in R2.
 *
 *   npx tsx scripts/export-colour-manifest.ts            # -> runs/colour/manifest.jsonl
 *
 * Presigned URLs expire in ~6h, so run the Python step (worker/backfill_colour.py)
 * the same day. For a Kaggle run use --catalogue-only (public URLs never expire)
 * and do the R2 originals locally.
 */
import { createWriteStream, mkdirSync } from 'node:fs'

import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { pgClient } from './lib/pg'

const catalogueOnly = process.argv.includes('--catalogue-only')
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

async function main(): Promise<void> {
  const db = pgClient()
  await db.connect()
  const { rows } = await db.query<{ id: string; image_url: string | null; storage_key: string | null }>(
    `select id, image_url, storage_key from public.match_references
      where retired_at is null and status = 'indexed' and colour is null
        and (image_url is not null ${catalogueOnly ? '' : 'or storage_key is not null'})
      order by image_url is null`,
  )
  await db.end()
  mkdirSync('runs/colour', { recursive: true })
  const out = createWriteStream('runs/colour/manifest.jsonl')
  let n = 0
  for (const r of rows) {
    let url = r.image_url
    if (!url && r.storage_key) {
      url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: r.storage_key }), { expiresIn: 6 * 3600 })
    }
    if (!url) continue
    out.write(JSON.stringify({ reference_id: r.id, url }) + '\n')
    n += 1
  }
  out.end()
  console.log(`wrote runs/colour/manifest.jsonl: ${n} reference(s) need a colour signature${catalogueOnly ? ' (catalogue only)' : ''}`)
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
