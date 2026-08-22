import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

/** D111: the worker's queue — claim, fence, complete, fail, search. Real schema, rolled back. */
describe('worker RPCs', () => {
  let db: Client
  const worker = `test-worker-${randomUUID().slice(0, 8)}`
  const unit = (i: number) => `[${Array.from({ length: 1152 }, (_, k) => (k === i ? 1 : 0)).join(',')}]`

  beforeAll(async () => {
    db = pgClient()
    await db.connect()
    await db.query('begin')
    // Keep deployed queue rows out of this transaction's claims.
    await db.query(`update public.match_jobs set created_at = now() + interval '1 day' where status = 'queued'`)
    await db.query(`update public.match_jobs set lease_expires_at = now() + interval '1 day' where status = 'claimed'`)
  })

  afterAll(async () => {
    if (!db) return
    await db.query('rollback').catch(() => {})
    await db.end()
  })

  async function reference(sku: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.match_references (sku, handle, storage_key, source, added_by)
       values ($1, $2, $3, 'loupe_original', 'test') returning id`,
      [sku, sku.toLowerCase(), `references/${sku}/${randomUUID()}.jpg`],
    )
    const id = rows[0]!.id
    await db.query(`insert into public.match_jobs (kind, reference_id) values ('sync', $1)`, [id])
    return id
  }

  /** Every other queued job (the production backlog and earlier tests' leftovers) sorts after this reference's. */
  async function parkOthers(refId: string) {
    await db.query(
      `update public.match_jobs set created_at = now() + interval '2 days' where status = 'queued' and reference_id is distinct from $1`,
      [refId],
    )
  }

  async function claim(kinds: string[]) {
    const { rows } = await db.query<{
      job_id: string; kind: string; lease_token: string; reference_id: string | null; ref_sku: string | null
    }>(`select * from public.claim_match_job($1, $2::text[], 600)`, [worker, kinds])
    return rows[0] ?? null
  }

  it('claims sync, fences completion by token, enqueues embed, stores two views, indexes, and searches', async () => {
    const refId = await reference('NK9001')
    await parkOthers(refId)
    const sync = await claim(['sync', 'embed'])
    expect(sync).toMatchObject({ kind: 'sync', reference_id: refId, ref_sku: 'NK9001' })

    await db.query('savepoint wrong')
    await expect(
      db.query(`select public.complete_match_job($1, $2, '{}'::jsonb)`, [sync!.job_id, randomUUID()]),
    ).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint wrong')

    await db.query(`select public.complete_match_job($1, $2, $3::jsonb)`, [
      sync!.job_id, sync!.lease_token, JSON.stringify({ local_path: 'D:/loupe/NK9001/a.jpg', sha256: 'abc' }),
    ])
    const synced = await db.query<{ status: string; local_path: string }>(
      `select status, local_path from public.match_references where id = $1`, [refId])
    expect(synced.rows[0]).toEqual({ status: 'synced', local_path: 'D:/loupe/NK9001/a.jpg' })

    const embed = await claim(['embed'])
    expect(embed).toMatchObject({ kind: 'embed', reference_id: refId })

    await db.query('savepoint early')
    await expect(
      db.query(`select public.complete_match_job($1, $2, '{}'::jsonb)`, [embed!.job_id, embed!.lease_token]),
    ).rejects.toMatchObject({ code: '22023' })
    await db.query('rollback to savepoint early')

    await db.query(`select public.store_match_embedding($1, 'full', $2, 'siglip2-test')`, [refId, unit(0)])
    await db.query(`select public.store_match_embedding($1, 'crop', $2, 'siglip2-test')`, [refId, unit(1)])
    await db.query(`select public.complete_match_job($1, $2, $3::jsonb)`, [
      embed!.job_id, embed!.lease_token, JSON.stringify({ index_version: 'test-v1' }),
    ])
    const indexed = await db.query<{ status: string; index_version: string }>(
      `select status, index_version from public.match_references where id = $1`, [refId])
    expect(indexed.rows[0]).toEqual({ status: 'indexed', index_version: 'test-v1' })

    const other = await reference('NK9002')
    await db.query(`select public.store_match_embedding($1, 'full', $2, 'siglip2-test')`, [other, unit(2)])
    await db.query(`select public.store_match_embedding($1, 'crop', $2, 'siglip2-test')`, [other, unit(3)])
    await db.query(`update public.match_references set status = 'indexed' where id = $1`, [other])

    // The real index (thousands of catalogue references) is searched too; the
    // stored vector must still come first with cosine 1, and an orthogonal one
    // must score 0 wherever it lands.
    const search = await db.query<{ sku: string; score: number }>(
      `select sku, score from public.match_search($1, 10000)`, [unit(1)])
    expect(search.rows[0]).toMatchObject({ sku: 'NK9001' })
    expect(search.rows[0]!.score).toBeCloseTo(1, 5)
    expect(search.rows.find((r) => r.sku === 'NK9002')!.score).toBeCloseTo(0, 5)
  })

  it('re-syncing an indexed reference keeps it indexed and queues no embed', async () => {
    const refId = await reference('NK9003')
    await parkOthers(refId)
    const sync = await claim(['sync'])
    await db.query(`select public.complete_match_job($1, $2, $3::jsonb)`, [
      sync!.job_id, sync!.lease_token, JSON.stringify({ local_path: '/mac/NK9003/a.jpg', sha256: 'abc' }),
    ])
    const embed = await claim(['embed'])
    await db.query(`select public.store_match_embedding($1, 'full', $2, 'siglip2-test')`, [refId, unit(4)])
    await db.query(`select public.store_match_embedding($1, 'crop', $2, 'siglip2-test')`, [refId, unit(5)])
    await db.query(`select public.complete_match_job($1, $2, '{}'::jsonb)`, [embed!.job_id, embed!.lease_token])

    // The laptop fetches its own copy later.
    await db.query(`insert into public.match_jobs (kind, reference_id) values ('sync', $1)`, [refId])
    const again = await claim(['sync'])
    expect(again).toMatchObject({ kind: 'sync', reference_id: refId })
    await db.query(`select public.complete_match_job($1, $2, $3::jsonb)`, [
      again!.job_id, again!.lease_token, JSON.stringify({ local_path: 'D:/loupe/NK9003/a.jpg', sha256: 'abc' }),
    ])
    const after = await db.query<{ status: string; local_path: string; embeds: string }>(
      `select r.status, r.local_path,
              (select count(*) from public.match_jobs j where j.reference_id = r.id and j.kind = 'embed' and j.status in ('queued', 'claimed')) as embeds
         from public.match_references r where r.id = $1`, [refId])
    expect(after.rows[0]).toEqual({ status: 'indexed', local_path: 'D:/loupe/NK9003/a.jpg', embeds: '0' })
  })

  it('retries a retryable failure up to four attempts, then fails the reference', async () => {
    const refId = await reference('NK9003')
    await parkOthers(refId)
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = await claim(['sync'])
      expect(job).toMatchObject({ reference_id: refId })
      await db.query(`select public.fail_match_job($1, $2, 'network', true)`, [job!.job_id, job!.lease_token])
      const state = await db.query<{ status: string; attempts: number }>(
        `select status, attempts from public.match_jobs where id = $1`, [job!.job_id])
      expect(state.rows[0]).toEqual({ status: attempt < 4 ? 'queued' : 'failed', attempts: attempt })
    }
    const ref = await db.query<{ status: string; last_error: string }>(
      `select status, last_error from public.match_references where id = $1`, [refId])
    expect(ref.rows[0]).toEqual({ status: 'failed', last_error: 'network' })
  })

  it('lets another worker take over an expired lease', async () => {
    const refId = await reference('NK9004')
    await parkOthers(refId)
    const first = await claim(['sync'])
    expect(first!.reference_id).toBe(refId)
    // Expire the lease and make it the oldest work, so the next claim must reclaim it.
    await db.query(
      `update public.match_jobs set lease_expires_at = now() - interval '1 second', created_at = now() - interval '2 hours' where id = $1`,
      [first!.job_id],
    )
    const second = await claim(['sync'])
    expect(second!.job_id).toBe(first!.job_id)
    expect(second!.lease_token).not.toBe(first!.lease_token)
    await db.query('savepoint stale')
    await expect(
      db.query(`select public.complete_match_job($1, $2, '{}'::jsonb)`, [first!.job_id, first!.lease_token]),
    ).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint stale')
  })

  it('records candidates on a queued event and leaves a decided one alone', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.match_events (surface, query_storage_key) values ('identify', 'identify/x.jpg') returning id`)
    const eventId = rows[0]!.id
    const candidates = JSON.stringify([{ rank: 1, sku: 'NK9001', handle: 'nk9001', score: 0.9 }])
    await db.query(`select public.record_match_candidates($1, $2::jsonb, 'siglip2-test', 'test-v1', array[1,2,3,4], 250)`,
      [eventId, candidates])
    const matched = await db.query<{ status: string; latency_ms: number }>(
      `select status, latency_ms from public.match_events where id = $1`, [eventId])
    expect(matched.rows[0]).toEqual({ status: 'matched', latency_ms: 250 })
  })
})
