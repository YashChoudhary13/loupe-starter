import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

/**
 * D110: every accepted photograph waits in `identifying` with one match event
 * and one identify job until an operator decides. Real schema, rolled back.
 */
describe('identification gate', () => {
  let db: Client
  const actor = 'test:gate@example.com'

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

  async function discover(mime = 'image/jpeg') {
    const driveId = `gate-${randomUUID()}`
    const first = await db.query<{ id: string; inserted: boolean; status: string }>(
      `select * from public.discover_intake_file($1, 'IMG_1.jpg', 'md5', 1234, $2, 'test')`,
      [driveId, mime],
    )
    return { driveId, row: first.rows[0]! }
  }

  async function eventFor(intakeId: string) {
    const { rows } = await db.query<{ id: string; status: string; surface: string; query_storage_key: string }>(
      `select id, status, surface, query_storage_key from public.match_events where intake_file_id = $1`,
      [intakeId],
    )
    return rows
  }

  it('parks a Drive discovery in identifying with exactly one event and one identify job, idempotently', async () => {
    const { driveId, row } = await discover()
    expect(row.inserted).toBe(true)
    expect(row.status).toBe('identifying')

    const replay = await db.query<{ inserted: boolean; status: string }>(
      `select inserted, status from public.discover_intake_file($1, 'IMG_1.jpg', 'md5', 1234, 'image/jpeg', 'test')`,
      [driveId],
    )
    expect(replay.rows[0]).toEqual({ inserted: false, status: 'identifying' })

    const events = await eventFor(row.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'queued', surface: 'drive', query_storage_key: `drive:${driveId}` })

    const jobs = await db.query<{ kind: string; status: string }>(
      `select kind, status from public.match_jobs where match_event_id = $1`,
      [events[0]!.id],
    )
    expect(jobs.rows).toEqual([{ kind: 'identify', status: 'queued' }])

    const again = await db.query<{ id: string }>(
      `select public.request_identification($1, 'drive', 'test') as id`,
      [row.id],
    )
    expect(again.rows[0]!.id).toBe(events[0]!.id)
  })

  it('still rejects an unsupported format permanently and requests nothing for it', async () => {
    const { row } = await discover('image/heic')
    expect(row.status).toBe('failed')
    expect(await eventFor(row.id)).toHaveLength(0)
  })

  it('new_product sends the photograph to enhancement, restock parks it with a decision row', async () => {
    const a = await discover()
    const [eventA] = await eventFor(a.row.id)
    await db.query(`select public.decide_identification($1, 'new_product', null, null, $2)`, [eventA!.id, actor])
    const afterA = await db.query<{ status: string }>(`select status from public.intake_files where id = $1`, [a.row.id])
    expect(afterA.rows[0]!.status).toBe('discovered')

    const b = await discover()
    const [eventB] = await eventFor(b.row.id)
    await db.query(`select public.decide_identification($1, 'restock', 'nk845', 3::smallint, $2)`, [eventB!.id, actor])
    const afterB = await db.query<{ status: string }>(`select status from public.intake_files where id = $1`, [b.row.id])
    expect(afterB.rows[0]!.status).toBe('restock')
    const decision = await db.query<{ sku: string; status: string }>(
      `select sku, status from public.restock_decisions where intake_file_id = $1`,
      [b.row.id],
    )
    expect(decision.rows[0]).toEqual({ sku: 'NK845', status: 'pending' })
    const decided = await db.query<{ decision: string; chosen_sku: string; chosen_rank: number }>(
      `select decision, chosen_sku, chosen_rank from public.match_events where id = $1`,
      [eventB!.id],
    )
    expect(decided.rows[0]).toEqual({ decision: 'restock', chosen_sku: 'NK845', chosen_rank: 3 })

    await db.query('savepoint twice')
    await expect(
      db.query(`select public.decide_identification($1, 'new_product', null, null, $2)`, [eventB!.id, actor]),
    ).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint twice')
  })
})
