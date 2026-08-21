import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

/** D110: the warehouse Identify flow — no intake row, references only after confirmation. */
describe('identify uploads', () => {
  let db: Client
  const actor = 'test:identify@example.com'

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

  async function pendingIdentifyUpload() {
    const id = randomUUID()
    await db.query(
      `insert into public.manual_uploads (id, filename, mime_type, bytes, storage_key, created_by, target)
       values ($1, $2, 'image/jpeg', 1234, $3, $4, 'identify')`,
      [id, `shelf-${id}.jpg`, `manual/${id}/original.jpg`, actor],
    )
    return id
  }

  async function finalized() {
    const uploadId = await pendingIdentifyUpload()
    const { rows } = await db.query<{ id: string }>(
      `select public.finalize_identify_upload($1, $2, '0123456789abcdef', $3) as id`,
      [uploadId, `manual/${uploadId}/thumb.webp`, actor],
    )
    return { uploadId, eventId: rows[0]!.id }
  }

  it('creates a match event and an identify job, idempotently, with no intake row', async () => {
    const { uploadId, eventId } = await finalized()
    const again = await db.query<{ id: string }>(
      `select public.finalize_identify_upload($1, $2, 'x', $3) as id`,
      [uploadId, `manual/${uploadId}/thumb.webp`, actor],
    )
    expect(again.rows[0]!.id).toBe(eventId)

    const event = await db.query<{ surface: string; status: string; query_storage_key: string; intake_file_id: string | null }>(
      `select surface, status, query_storage_key, intake_file_id from public.match_events where id = $1`, [eventId])
    expect(event.rows[0]).toEqual({ surface: 'identify', status: 'queued', query_storage_key: `manual/${uploadId}/original.jpg`, intake_file_id: null })
    const jobs = await db.query(`select 1 from public.match_jobs where match_event_id = $1 and kind = 'identify'`, [eventId])
    expect(jobs.rowCount).toBe(1)
    const upload = await db.query<{ status: string; intake_file_id: string | null }>(
      `select status, intake_file_id from public.manual_uploads where id = $1`, [uploadId])
    expect(upload.rows[0]).toEqual({ status: 'completed', intake_file_id: null })
  })

  it('a confirmation registers the photograph as a reference pending sync; none_of_these learns nothing', async () => {
    const { eventId } = await finalized()
    await db.query(
      `update public.match_events set status = 'matched', candidates = $2::jsonb where id = $1`,
      [eventId, JSON.stringify([{ rank: 1, sku: 'NK845', handle: 'necklace-845', score: 0.8 }, { rank: 2, sku: 'NK828', handle: 'necklace-828', score: 0.7 }])],
    )
    const confirmed = await db.query<{ ref: string }>(
      `select public.confirm_identification($1, 'confirmed', 'nk828', 2::smallint, $2) as ref`, [eventId, actor])
    const ref = await db.query<{ sku: string; handle: string; source: string; status: string; match_event_id: string }>(
      `select sku, handle, source, status, match_event_id from public.match_references where id = $1`, [confirmed.rows[0]!.ref])
    expect(ref.rows[0]).toEqual({ sku: 'NK828', handle: 'necklace-828', source: 'identify_confirmed', status: 'pending_sync', match_event_id: eventId })
    const sync = await db.query(`select 1 from public.match_jobs where reference_id = $1 and kind = 'sync' and status = 'queued'`, [confirmed.rows[0]!.ref])
    expect(sync.rowCount).toBe(1)
    const event = await db.query<{ decision: string; chosen_sku: string; chosen_rank: number; reference_id: string }>(
      `select decision, chosen_sku, chosen_rank, reference_id from public.match_events where id = $1`, [eventId])
    expect(event.rows[0]).toEqual({ decision: 'confirmed', chosen_sku: 'NK828', chosen_rank: 2, reference_id: confirmed.rows[0]!.ref })

    await db.query('savepoint twice')
    await expect(
      db.query(`select public.confirm_identification($1, 'none_of_these', null, null, $2)`, [eventId, actor]),
    ).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint twice')

    const other = await finalized()
    const none = await db.query<{ ref: string | null }>(
      `select public.confirm_identification($1, 'none_of_these', null, null, $2) as ref`, [other.eventId, actor])
    expect(none.rows[0]!.ref).toBeNull()
    const refs = await db.query(`select 1 from public.match_references where match_event_id = $1`, [other.eventId])
    expect(refs.rowCount).toBe(0)
  })

  it('refuses to confirm an intake photograph through the identify path', async () => {
    const driveId = `identify-gate-${randomUUID()}`
    const discovered = await db.query<{ id: string }>(
      `select id from public.discover_intake_file($1, 'IMG_9.jpg', 'md5', 1234, 'image/jpeg', 'test')`, [driveId])
    const event = await db.query<{ id: string }>(
      `select id from public.match_events where intake_file_id = $1`, [discovered.rows[0]!.id])
    await db.query('savepoint wrong_path')
    await expect(
      db.query(`select public.confirm_identification($1, 'confirmed', 'NK845', 1::smallint, $2)`, [event.rows[0]!.id, actor]),
    ).rejects.toMatchObject({ code: '22023' })
    await db.query('rollback to savepoint wrong_path')
  })
})
