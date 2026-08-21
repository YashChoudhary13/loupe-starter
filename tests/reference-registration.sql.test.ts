import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

/** D111: published originals become references exactly once; ready images never do. */
describe('reference registration', () => {
  let db: Client

  beforeAll(async () => {
    db = pgClient()
    await db.connect()
    await db.query('begin')
    // Keep the deployed backlog out of this transaction's sweep.
    await db.query(`update public.product_drafts set status = 'failed' where status = 'published'
                      and id in (select d.id from public.product_drafts d join public.intake_files f on f.product_draft_id = d.id
                                  join public.image_versions iv on iv.intake_file_id = f.id and iv.kind = 'original' and iv.purged_at is null
                                  where not exists (select 1 from public.match_references r where r.intake_file_id = f.id))`)
  })

  afterAll(async () => {
    if (!db) return
    await db.query('rollback').catch(() => {})
    await db.end()
  })

  async function published(source: 'drive' | 'manual', purged = false) {
    const n = Math.floor(Math.random() * 900000 + 100000)
    const category = await db.query<{ id: string }>(`select id from public.categories order by sort_order limit 1`)
    const draft = await db.query<{ id: string }>(
      `insert into public.product_drafts (category_id, price_paise, weight_g, stock, status, reserved_sku, reserved_handle, shopify_product_id, published_at, created_by)
       values ($1, 10000, 0, 1, 'published', $2, $3, $4, now(), 'test:register') returning id`,
      [category.rows[0]!.id, `NK8${n}`, `register-test-${n}`, `gid://shopify/Product/register-${n}`],
    )
    const file = await db.query<{ id: string }>(
      `insert into public.intake_files (drive_file_id, filename, bytes, mime_type, status, product_draft_id, published_at, source)
       values ($1, $2, 1234, 'image/jpeg', 'published', $3, now(), $4) returning id`,
      [`${source}:register-${randomUUID()}`, `IMG_${n}.jpg`, draft.rows[0]!.id, source],
    )
    await db.query(
      `insert into public.image_versions (intake_file_id, version_no, kind, storage_key, purged_at)
       values ($1, 0, 'original', $2, $3)`,
      [file.rows[0]!.id, `originals/${file.rows[0]!.id}.jpg`, purged ? new Date().toISOString() : null],
    )
    return { sku: `NK8${n}`, intakeId: file.rows[0]!.id }
  }

  it('registers a drive original once, skips ready images and purged originals', async () => {
    const drive = await published('drive')
    await published('manual')
    await published('drive', true)

    const first = await db.query<{ n: number }>(`select public.register_published_originals(100, 'test') as n`)
    expect(first.rows[0]!.n).toBe(1)
    const second = await db.query<{ n: number }>(`select public.register_published_originals(100, 'test') as n`)
    expect(second.rows[0]!.n).toBe(0)

    const ref = await db.query<{ sku: string; source: string; status: string; storage_key: string }>(
      `select sku, source, status, storage_key from public.match_references where intake_file_id = $1`, [drive.intakeId])
    expect(ref.rows[0]).toEqual({ sku: drive.sku, source: 'loupe_original', status: 'pending_sync', storage_key: `originals/${drive.intakeId}.jpg` })
    const job = await db.query(`select 1 from public.match_jobs j join public.match_references r on r.id = j.reference_id where r.intake_file_id = $1 and j.kind = 'sync'`, [drive.intakeId])
    expect(job.rowCount).toBe(1)

    const again = await db.query<{ id: string }>(
      `select public.register_reference($1, $2, 'h', null, 'references/x.jpg', 'loupe_original', 'test') as id`, [drive.intakeId, drive.sku])
    const same = await db.query<{ id: string }>(`select id from public.match_references where intake_file_id = $1`, [drive.intakeId])
    expect(again.rows[0]!.id).toBe(same.rows[0]!.id)
  })
})
