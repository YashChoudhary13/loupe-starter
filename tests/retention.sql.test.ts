import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

/**
 * D109: the database never offers an original for purging and never records one
 * as purged, however old the product is. Runs against the real schema inside a
 * transaction that is rolled back.
 */
describe('retention keeps originals', () => {
  let db: Client

  beforeAll(async () => {
    db = pgClient()
    await db.connect()
    await db.query('begin')
  })

  afterAll(async () => {
    if (!db) return
    await db.query('rollback').catch(() => {})
    await db.end()
  })

  async function publishedPhotograph(daysAgo: number) {
    const n = Math.floor(Math.random() * 900000 + 100000)
    const category = await db.query<{ id: string }>(
      `select id from public.categories order by sort_order limit 1`,
    )
    const draft = await db.query<{ id: string }>(
      `insert into public.product_drafts (
         category_id, price_paise, weight_g, stock, status, reserved_sku, reserved_handle,
         shopify_product_id, published_at, shopify_first_sent_at, created_by
       ) values (
         $1, 10000, 0, 1, 'published', $2, $3, $4,
         now() - make_interval(days => $5), now() - make_interval(days => $5), 'test:retention'
       ) returning id`,
      [category.rows[0]!.id, `NK9${n}`, `retention-test-${n}`, `gid://shopify/Product/retention-${n}`, daysAgo],
    )
    const file = await db.query<{ id: string }>(
      `insert into public.intake_files (drive_file_id, filename, bytes, mime_type, status, product_draft_id, published_at)
       values ($1, $2, 1234, 'image/jpeg', 'published', $3, now())
       returning id`,
      [`retention-test-${randomUUID()}`, `IMG_${n}.jpg`, draft.rows[0]!.id],
    )
    const fileId = file.rows[0]!.id
    const original = await db.query<{ id: string }>(
      `insert into public.image_versions (intake_file_id, version_no, kind, storage_key)
       values ($1, 0, 'original', $2) returning id`,
      [fileId, `originals/${fileId}.jpg`],
    )
    const generated = await db.query<{ id: string }>(
      `insert into public.image_versions (intake_file_id, version_no, kind, storage_key, thumb_key, prompt_text, model, cost_usd, description_injected, description_missing, is_selected)
       values ($1, 1, 'generated', $2, $3, 'test prompt', 'test/model', 0.07, true, false, true) returning id`,
      [fileId, `versions/${fileId}/v1.png`, `versions/${fileId}/v1_thumb.webp`],
    )
    return { fileId, originalId: original.rows[0]!.id, generatedId: generated.rows[0]!.id }
  }

  it('offers the generated version of an old product and never its original', async () => {
    const { originalId, generatedId } = await publishedPhotograph(10)
    const candidates = await db.query<{ image_version_id: string }>(
      `select image_version_id from public.retention_candidates(7, 10000)`,
    )
    const ids = candidates.rows.map((r) => r.image_version_id)
    expect(ids).toContain(generatedId)
    expect(ids).not.toContain(originalId)
  })

  it('refuses to mark an original purged even when asked directly', async () => {
    const { originalId, generatedId } = await publishedPhotograph(10)
    const marked = await db.query<{ n: number }>(
      `select public.mark_versions_purged($1::uuid[], 'test:retention') as n`,
      [[originalId, generatedId]],
    )
    expect(marked.rows[0]!.n).toBe(1)
    const rows = await db.query<{ id: string; purged_at: string | null }>(
      `select id, purged_at from public.image_versions where id = any($1::uuid[])`,
      [[originalId, generatedId]],
    )
    const byId = new Map(rows.rows.map((r) => [r.id, r.purged_at]))
    expect(byId.get(originalId)).toBeNull()
    expect(byId.get(generatedId)).not.toBeNull()
  })
})
