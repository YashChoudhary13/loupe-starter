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

async function publishedDraft(): Promise<string> {
  const category = await db.query<{ id: string }>(
    `select id from public.categories where shopify_tag is not null order by sort_order limit 1`,
  )
  const result = await db.query<{ id: string }>(
    `insert into public.product_drafts (
       category_id, price_paise, weight_g, stock, status, reserved_sku,
       reserved_handle, shopify_product_id, published_at, created_by
     )
     values (
       $1, 10000, 0, 1, 'published', 'NK999991', 'phase6-reconcile',
       'gid://shopify/Product/999991', now(), 'test:phase6'
     )
     returning id`,
    [category.rows[0]!.id],
  )
  return result.rows[0]!.id
}

describe('Phase 6 reconciliation lease and durable result', () => {
  it('admits one owner, returns the active run to overlaps, and completes atomically', async () => {
    const draftId = await publishedDraft()
    const first = await db.query<{ run_id: string; lease_token: string; owned: boolean }>(
      `select * from public.claim_shopify_reconciliation($1, 300)`,
      ['test:first'],
    )
    const overlap = await db.query<{
      run_id: string
      lease_token: string | null
      owned: boolean
    }>(`select * from public.claim_shopify_reconciliation($1, 300)`, ['test:overlap'])
    expect(first.rows[0]?.owned).toBe(true)
    expect(overlap.rows[0]).toEqual({
      run_id: first.rows[0]!.run_id,
      lease_token: null,
      owned: false,
    })

    const issues = [
      {
        productDraftId: draftId,
        shopifyProductId: 'gid://shopify/Product/999991',
        code: 'field_mismatch',
        field: 'title',
        expected: 'Necklace 999991',
        actual: 'Changed',
        message: 'The Shopify title changed.',
      },
    ]
    const completed = await db.query<{
      total_products: number
      matched_products: number
      issue_count: number
    }>(
      `select * from public.complete_shopify_reconciliation($1, $2, 3, $3::jsonb, $4)`,
      [
        first.rows[0]!.run_id,
        first.rows[0]!.lease_token,
        JSON.stringify(issues),
        'test:worker',
      ],
    )
    expect(completed.rows[0]).toEqual({
      total_products: 3,
      matched_products: 2,
      issue_count: 1,
    })
    const run = await db.query<{
      status: string
      lease_token: string | null
      issue_count: number
    }>(
      `select status, lease_token, issue_count
         from public.shopify_reconciliation_runs where id = $1`,
      [first.rows[0]!.run_id],
    )
    expect(run.rows[0]).toEqual({ status: 'completed', lease_token: null, issue_count: 1 })
  })

  it('turns an expired active run into visible failure before starting another', async () => {
    const first = await db.query<{ run_id: string }>(
      `select * from public.claim_shopify_reconciliation($1, 30)`,
      ['test:first'],
    )
    await db.query(
      `update public.shopify_reconciliation_runs
          set lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [first.rows[0]!.run_id],
    )
    const second = await db.query<{ run_id: string; owned: boolean }>(
      `select * from public.claim_shopify_reconciliation($1, 30)`,
      ['test:second'],
    )
    expect(second.rows[0]?.owned).toBe(true)
    expect(second.rows[0]?.run_id).not.toBe(first.rows[0]?.run_id)
    const expired = await db.query<{ status: string; error: string }>(
      `select status, error from public.shopify_reconciliation_runs where id = $1`,
      [first.rows[0]!.run_id],
    )
    expect(expired.rows[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('lease expired'),
    })
  })

  it('rejects completion by a stale token', async () => {
    const claim = await db.query<{ run_id: string }>(
      `select * from public.claim_shopify_reconciliation($1, 300)`,
      ['test:first'],
    )
    await expect(
      db.query(
        `select * from public.complete_shopify_reconciliation(
           $1, gen_random_uuid(), 0, '[]'::jsonb, 'test:stale'
         )`,
        [claim.rows[0]!.run_id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })
})
