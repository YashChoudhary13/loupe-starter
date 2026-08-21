import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

/** D112: the two restock paths and the way back to Identify. Real schema, rolled back. */
describe('restock workflow', () => {
  let db: Client
  const actor = 'test:restock@example.com'

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

  /** A photograph an operator already marked as a restock of NK845 in Identify. */
  async function restockPhotograph() {
    const upload = randomUUID()
    const { rows } = await db.query<{ id: string }>(
      `insert into public.intake_files (drive_file_id, filename, bytes, mime_type, status, source, source_storage_key)
       values ($1, 'IMG_R.jpg', 1234, 'image/jpeg', 'identifying', 'upload', $2) returning id`,
      [`upload:${upload}`, `manual/${upload}/original.jpg`],
    )
    const intakeId = rows[0]!.id
    const event = await db.query<{ id: string }>(`select public.request_identification($1, 'upload', $2) as id`, [intakeId, actor])
    await db.query(`select public.decide_identification($1, 'restock', 'NK845', 1::smallint, $2)`, [event.rows[0]!.id, actor])
    return { intakeId, eventId: event.rows[0]!.id, sourceKey: `manual/${upload}/original.jpg`, thumbKey: `manual/${upload}/thumb.webp` }
  }

  it('restock existing: begin records intent, complete restocks and registers the photograph as a reference', async () => {
    const p = await restockPhotograph()
    const quantities = JSON.stringify([{ inventory_item_id: 'gid://shopify/InventoryItem/1', label: 'Gold', before: 3, after: 15 }])
    const begun = await db.query<{ id: string }>(
      `select public.begin_restock_existing($1, 'gid://shopify/Product/845', $2::jsonb, $3) as id`, [p.intakeId, quantities, actor])
    await db.query(`select public.complete_restock_existing($1, $2, $3)`, [begun.rows[0]!.id, p.sourceKey, actor])

    const file = await db.query<{ status: string }>(`select status from public.intake_files where id = $1`, [p.intakeId])
    expect(file.rows[0]!.status).toBe('restocked')
    const decision = await db.query<{ status: string; path: string }>(`select status, path from public.restock_decisions where id = $1`, [begun.rows[0]!.id])
    expect(decision.rows[0]).toEqual({ status: 'completed', path: 'restock_existing' })
    const ref = await db.query<{ sku: string; source: string; status: string; storage_key: string }>(
      `select sku, source, status, storage_key from public.match_references where intake_file_id = $1`, [p.intakeId])
    expect(ref.rows[0]).toEqual({ sku: 'NK845', source: 'restock', status: 'pending_sync', storage_key: p.sourceKey })
    const event = await db.query<{ reference_id: string | null }>(`select reference_id from public.match_events where id = $1`, [p.eventId])
    expect(event.rows[0]!.reference_id).not.toBeNull()

    // Completing twice is harmless; beginning again is refused.
    await db.query(`select public.complete_restock_existing($1, $2, $3)`, [begun.rows[0]!.id, p.sourceKey, actor])
    await db.query('savepoint again')
    await expect(db.query(`select public.begin_restock_existing($1, 'x', '[]'::jsonb, $2)`, [p.intakeId, actor])).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint again')
  })

  it('new SKU without a new image: the photograph lands enhanced with its original selected; publish finds the supersession', async () => {
    const p = await restockPhotograph()
    await db.query(
      `select public.begin_new_sku_from_restock($1, 'gid://shopify/Product/845', false, null, $2, $3, 1600, 1200, $4)`,
      [p.intakeId, p.sourceKey, p.thumbKey, actor],
    )
    const file = await db.query<{ status: string }>(`select status from public.intake_files where id = $1`, [p.intakeId])
    expect(file.rows[0]!.status).toBe('enhanced')
    const version = await db.query<{ kind: string; is_selected: boolean; storage_key: string }>(
      `select kind, is_selected, storage_key from public.image_versions where intake_file_id = $1`, [p.intakeId])
    expect(version.rows[0]).toEqual({ kind: 'original', is_selected: true, storage_key: p.sourceKey })

    const category = await db.query<{ id: string }>(`select id from public.categories order by sort_order limit 1`)
    const draft = await db.query<{ id: string }>(
      `select public.create_product_draft($1, $2::uuid[], $3) as id`, [category.rows[0]!.id, [p.intakeId], actor])
    const pending = await db.query<{ old_sku: string; old_shopify_product_id: string }>(
      `select old_sku, old_shopify_product_id from public.pending_supersession($1)`, [draft.rows[0]!.id])
    expect(pending.rows[0]).toEqual({ old_sku: 'NK845', old_shopify_product_id: 'gid://shopify/Product/845' })

    const decisionId = (await db.query<{ id: string }>(`select id from public.restock_decisions where intake_file_id = $1`, [p.intakeId])).rows[0]!.id
    await db.query(`select public.record_supersession($1, $2, 'gid://shopify/Product/845', $3)`, [draft.rows[0]!.id, decisionId, actor])
    const after = await db.query<{ supersedes_sku: string }>(`select supersedes_sku from public.product_drafts where id = $1`, [draft.rows[0]!.id])
    expect(after.rows[0]!.supersedes_sku).toBe('NK845')
    const none = await db.query(`select 1 from public.pending_supersession($1)`, [draft.rows[0]!.id])
    expect(none.rowCount).toBe(0)
  })

  it('new SKU with a new image: the photograph re-enters enhancement carrying its preset', async () => {
    const p = await restockPhotograph()
    await db.query(
      `select public.begin_new_sku_from_restock($1, null, true, 'necklace--ivory-sweep', null, null, null, null, $2)`, [p.intakeId, actor])
    const file = await db.query<{ status: string; preset_slug: string }>(`select status, preset_slug from public.intake_files where id = $1`, [p.intakeId])
    expect(file.rows[0]).toEqual({ status: 'discovered', preset_slug: 'necklace--ivory-sweep' })
  })

  it('not this one: back to Identify with a fresh match event', async () => {
    const p = await restockPhotograph()
    const reopened = await db.query<{ id: string }>(`select public.reopen_identification($1, $2) as id`, [p.intakeId, actor])
    expect(reopened.rows[0]!.id).not.toBe(p.eventId)
    const file = await db.query<{ status: string }>(`select status from public.intake_files where id = $1`, [p.intakeId])
    expect(file.rows[0]!.status).toBe('identifying')
    const decisions = await db.query(`select 1 from public.restock_decisions where intake_file_id = $1`, [p.intakeId])
    expect(decisions.rowCount).toBe(0)
  })
})
