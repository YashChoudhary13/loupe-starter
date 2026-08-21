/**
 * One-off (D111): published products whose original was purged from R2 before
 * D109 but still exists in Google Drive /Processed. Downloads each from Drive,
 * stores an immutable copy under references/{sku}/{intake_id}.{ext} and
 * registers it as a matcher reference.
 *
 *   npm run match:backfill            # dry run: lists what it would do
 *   npm run match:backfill -- --apply
 *
 * (NODE_OPTIONS=--conditions=react-server lets tsx import the server-only Drive client.)
 */
import { config } from 'dotenv'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

import { createClient } from '@supabase/supabase-js'

import { R2ObjectStore } from '../src/lib/enhance/storage'
import { googleDriveClient } from '../src/lib/google/drive-server'

const apply = process.argv.includes('--apply')

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env`)
  return value
}

interface Row {
  intake_file_id: string
  drive_file_id: string
  filename: string
  mime_type: string | null
  sku: string
  handle: string
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tif' }

async function main(): Promise<void> {
  const db = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const store = new R2ObjectStore({
    endpoint: required('R2_ENDPOINT'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
  })
  const drive = googleDriveClient()

  // Published drive photographs with a purged original and no reference yet.
  const { data, error } = await db
    .from('intake_files')
    .select('id, drive_file_id, filename, mime_type, product_drafts!inner ( reserved_sku, reserved_handle, status ), image_versions!inner ( kind, purged_at )')
    .eq('source', 'drive')
    .eq('status', 'published')
    .eq('product_drafts.status', 'published')
    .eq('image_versions.kind', 'original')
    .not('image_versions.purged_at', 'is', null)
  if (error) throw new Error(error.message)
  const { data: registered, error: refError } = await db.from('match_references').select('intake_file_id').not('intake_file_id', 'is', null)
  if (refError) throw new Error(refError.message)
  const have = new Set((registered ?? []).map((r) => r.intake_file_id as string))

  const rows: Row[] = (data ?? [])
    .filter((r) => !have.has(r.id as string))
    .map((r) => {
      const draft = (Array.isArray(r.product_drafts) ? r.product_drafts[0] : r.product_drafts) as { reserved_sku: string; reserved_handle: string }
      return { intake_file_id: r.id as string, drive_file_id: r.drive_file_id as string, filename: r.filename as string, mime_type: r.mime_type as string | null, sku: draft.reserved_sku, handle: draft.reserved_handle }
    })
  console.log(`${rows.length} purged originals without a reference${apply ? '' : ' (dry run — pass --apply to copy and register)'}`)

  let copied = 0, missing = 0, failed = 0
  for (const row of rows) {
    const ext = EXT[row.mime_type ?? ''] ?? 'jpg'
    const key = `references/${row.sku}/${row.intake_file_id}.${ext}`
    try {
      if (!apply) {
        console.log(`  would copy ${row.sku} ${row.filename} -> ${key}`)
        continue
      }
      let bytes: Buffer
      try {
        bytes = await drive.downloadFile(row.drive_file_id)
      } catch (cause) {
        missing += 1
        console.log(`  ${row.sku}: Drive file gone (${cause instanceof Error ? cause.message.slice(0, 80) : cause})`)
        continue
      }
      await store.putImmutable(key, bytes, row.mime_type ?? 'image/jpeg', { 'intake-id': row.intake_file_id, source: 'backfill-drive' })
      const { error: regError } = await db.rpc('register_reference', {
        p_intake_file_id: row.intake_file_id, p_sku: row.sku, p_handle: row.handle, p_title: null,
        p_storage_key: key, p_source: 'loupe_original', p_actor: 'backfill:drive-2026-08-21',
      })
      if (regError) throw new Error(regError.message)
      copied += 1
      console.log(`  ${row.sku} ${(bytes.byteLength / 1e6).toFixed(1)} MB -> ${key}`)
    } catch (cause) {
      failed += 1
      console.log(`  ${row.sku}: FAILED ${cause instanceof Error ? cause.message : cause}`)
    }
  }
  if (apply) console.log(`copied+registered ${copied}, Drive file missing ${missing}, failed ${failed}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
