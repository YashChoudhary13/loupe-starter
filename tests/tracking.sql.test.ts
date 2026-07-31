import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

let db: Client

beforeAll(async () => {
  db = pgClient()
  await db.connect()
})

beforeEach(async () => {
  await db.query('begin')
})

afterEach(async () => {
  await db.query('rollback')
})

afterAll(async () => {
  await db.end()
})

async function intake(input: {
  status?: string
  errorClass?: string | null
  error?: string | null
  phash?: string | null
  grouped?: boolean
} = {}): Promise<string> {
  const category = await db.query<{ id: string }>(
    `select id from public.categories where active order by sort_order limit 1`,
  )
  let draftId: string | null = null
  if (input.grouped) {
    const draft = await db.query<{ id: string }>(
      `insert into public.product_drafts (category_id, status, created_by)
       values ($1, 'assembling', 'test:phase6')
       returning id`,
      [category.rows[0]!.id],
    )
    draftId = draft.rows[0]!.id
  }
  const status = input.grouped ? 'grouped' : (input.status ?? 'enhanced')
  const result = await db.query<{ id: string }>(
    `insert into public.intake_files (
       drive_file_id, filename, bytes, mime_type, status, attempts,
       last_error, error_class, phash, product_draft_id,
       lease_token, lease_expires_at, enhanced_at, grouped_at
     )
     values (
       'phase6-' || gen_random_uuid(), 'phase6.jpg', 100, 'image/jpeg',
       $1::public.intake_status, case when $1 = 'failed' then 5 else 0 end,
       $2, $3::public.error_class, $4, $5,
       case when $1 = 'enhancing' then gen_random_uuid() else null end,
       case when $1 = 'enhancing' then now() + interval '10 minutes' else null end,
       case when $1 in ('enhanced','grouped') then now() else null end,
       case when $1 = 'grouped' then now() else null end
     )
     returning id`,
    [status, input.error ?? null, input.errorClass ?? null, input.phash ?? null, draftId],
  )
  return result.rows[0]!.id
}

describe('Phase 6 tracking transitions', () => {
  it('stores one fenced deterministic pHash and refuses a changed replay', async () => {
    const id = await intake({ status: 'enhancing' })
    const lease = await db.query<{ lease_token: string }>(
      `select lease_token from public.intake_files where id = $1`,
      [id],
    )
    const token = lease.rows[0]!.lease_token

    await expect(
      db.query(`select public.store_intake_phash($1, $2, $3, $4)`, [
        id,
        token,
        '0123456789abcdef',
        'test:phase6',
      ]),
    ).resolves.toBeDefined()
    await expect(
      db.query(`select public.store_intake_phash($1, $2, $3, $4)`, [
        id,
        token,
        '0123456789abcdef',
        'test:phase6',
      ]),
    ).resolves.toBeDefined()
    const stored = await db.query<{ phash: string }>(
      `select phash from public.intake_files where id = $1`,
      [id],
    )
    const events = await db.query<{ count: string }>(
      `select count(*) from public.events
        where entity_id = $1 and event = 'intake.phash_stored'`,
      [id],
    )
    expect(stored.rows[0]?.phash).toBe('0123456789abcdef')
    expect(events.rows[0]?.count).toBe('1')
    await expect(
      db.query(`select public.store_intake_phash($1, $2, $3, $4)`, [
        id,
        token,
        'ffffffffffffffff',
        'test:phase6',
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('retries only failed retryable work and audits the reset', async () => {
    const retryable = await intake({
      status: 'failed',
      errorClass: 'retryable',
      error: 'Provider unavailable.',
    })
    const permanent = await intake({
      status: 'failed',
      errorClass: 'permanent',
      error: 'Unsupported input.',
    })

    const result = await db.query<{ retry_intake_file: string }>(
      `select public.retry_intake_file($1, $2)`,
      [retryable, 'operator@example.com'],
    )
    expect(result.rows[0]?.retry_intake_file).toBe('discovered')
    const row = await db.query<{
      status: string
      attempts: number
      last_error: string | null
      error_class: string | null
    }>(
      `select status, attempts, last_error, error_class
         from public.intake_files where id = $1`,
      [retryable],
    )
    expect(row.rows[0]).toEqual({
      status: 'discovered',
      attempts: 0,
      last_error: null,
      error_class: null,
    })
    await expect(
      db.query(`select public.retry_intake_file($1, $2)`, [permanent, 'operator@example.com']),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('skips ungrouped work but refuses a grouped photograph', async () => {
    const ungrouped = await intake()
    const grouped = await intake({ grouped: true })
    await expect(
      db.query(`select public.skip_intake_file($1, $2)`, [ungrouped, 'operator@example.com']),
    ).resolves.toBeDefined()
    await expect(
      db.query(`select public.skip_intake_file($1, $2)`, [grouped, 'operator@example.com']),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('persists one canonical duplicate decision and only marks the chosen target', async () => {
    const first = await intake({ phash: '0000000000000000' })
    const second = await intake({ phash: '0000000000000001' })

    await db.query(
      `select public.review_duplicate_pair($1, $2, 'dismissed', null, 1, $3)`,
      [second, first, 'operator@example.com'],
    )
    await db.query(
      `select public.review_duplicate_pair($1, $2, 'duplicate', $2, 1, $3)`,
      [first, second, 'operator@example.com'],
    )

    const review = await db.query<{
      left_intake_file_id: string
      right_intake_file_id: string
      decision: string
      duplicate_intake_file_id: string
    }>(`select left_intake_file_id, right_intake_file_id, decision, duplicate_intake_file_id
          from public.duplicate_reviews`)
    expect(review.rowCount).toBe(1)
    expect(review.rows[0]).toMatchObject({
      decision: 'duplicate',
      duplicate_intake_file_id: second,
    })
    const statuses = await db.query<{ id: string; status: string }>(
      `select id, status from public.intake_files where id in ($1, $2) order by id`,
      [first, second],
    )
    expect(statuses.rows.find((row) => row.id === first)?.status).toBe('enhanced')
    expect(statuses.rows.find((row) => row.id === second)?.status).toBe('duplicate')
  })

  it('refuses to mark grouped work duplicate', async () => {
    const ungrouped = await intake({ phash: '0000000000000000' })
    const grouped = await intake({ phash: '0000000000000001', grouped: true })
    await expect(
      db.query(
        `select public.review_duplicate_pair($1, $2, 'duplicate', $2, 1, $3)`,
        [ungrouped, grouped, 'operator@example.com'],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })
})
