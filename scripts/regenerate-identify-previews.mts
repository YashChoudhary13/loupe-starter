/**
 * One-off (2026-08-22): the vision worker stored a 256 px query preview, too soft
 * to judge a piece at full screen. Re-render every Drive photograph waiting or
 * matched in Identify to a 1536 px webp and overwrite its existing R2 object, so
 * the already-deployed lightbox serves a crisp image without a redeploy.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/regenerate-identify-previews.mts        # dry run
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/regenerate-identify-previews.mts --apply
 */
import { config } from 'dotenv'
config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import sharp from 'sharp'

import { googleDriveClient } from '../src/lib/google/drive-server'
import { pgClient } from './lib/pg'

const apply = process.argv.includes('--apply')
const EDGE = 1536

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
  const { rows } = await db.query<{ event_id: string; thumb_key: string; drive_file_id: string; filename: string }>(
    `select e.id as event_id, e.thumb_key, f.drive_file_id, f.filename
       from public.match_events e join public.intake_files f on f.id = e.intake_file_id
      where e.surface = 'drive' and e.status in ('queued', 'matched')
        and e.thumb_key is not null and f.drive_file_id is not null
      order by e.created_at`,
  )
  await db.end()
  console.log(`${rows.length} Drive preview(s) to regenerate at ${EDGE}px${apply ? '' : ' (dry run; pass --apply)'}`)
  if (!apply) return

  const drive = googleDriveClient()
  let done = 0
  let bytes = 0
  for (const r of rows) {
    try {
      const original = await drive.downloadFile(r.drive_file_id)
      const webp = await sharp(original)
        .rotate() // honour EXIF orientation
        .resize(EDGE, EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer()
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: r.thumb_key,
          Body: webp,
          ContentType: 'image/webp',
          CacheControl: 'private, max-age=31536000',
        }),
      )
      done += 1
      bytes += webp.byteLength
      process.stdout.write(`\r  ${done}/${rows.length}  ${(bytes / done / 1024).toFixed(0)} KB avg  (${r.filename})            `)
    } catch (cause) {
      console.error(`\n  FAILED ${r.filename} (${r.event_id}): ${cause instanceof Error ? cause.message : cause}`)
    }
  }
  console.log(`\nregenerated ${done} of ${rows.length}; ${(bytes / 1e6).toFixed(1)} MB total`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
