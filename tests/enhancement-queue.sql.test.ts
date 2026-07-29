/**
 * Phase 3B database state-machine integration proof.
 *
 * This runs against the deployed database in one transaction and rolls every
 * fixture and event back. It exercises the actual fencing and completion SQL,
 * not a TypeScript approximation of it.
 */
import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

interface Discovery {
  id: string
}

interface Claim {
  id: string
  lease_token: string
  attempts: number
  product_description: string | null
  description_missing_at: Date | null
}

interface Completion {
  id: string
  status: string
  attempts: number
  image_version_id: string
  version_no: number
  cost_usd: string
}

describe('Phase 3B enhancement SQL state machine', () => {
  let db: Client
  const source = 'phase3b-sql-integration'

  beforeAll(async () => {
    db = pgClient()
    await db.connect()
    await db.query('begin')
    await db.query(`set local statement_timeout = '30s'`)

    // Keep real queued work outside the candidate set while this transaction
    // calls the unfiltered production claim function.
    await db.query(`
      update public.intake_files
         set next_attempt_at = now() + interval '1 day'
       where status = 'discovered'
    `)
    await db.query(`
      update public.intake_files
         set lease_expires_at = now() + interval '1 day'
       where status = 'enhancing'
         and lease_expires_at <= now()
    `)
  })

  afterAll(async () => {
    if (!db) return
    await db.query('rollback').catch(() => {})
    await db.end()
  })

  async function discoverAndClaim(filename: string): Promise<Claim> {
    const discovery = await db.query<Discovery>(
      `select id
         from public.discover_intake_file($1, $2, $3, $4, $5, $6)`,
      [
        `phase3b-${randomUUID()}`,
        filename,
        'd41d8cd98f00b204e9800998ecf8427e',
        1024,
        'image/jpeg',
        source,
      ],
    )
    const claim = await db.query<Claim>(
      `select id, lease_token, attempts, product_description, description_missing_at
         from public.claim_intake_file(300)`,
    )
    expect(claim.rows[0]?.id).toBe(discovery.rows[0]?.id)
    return claim.rows[0]!
  }

  async function complete(
    claim: Pick<Claim, 'id' | 'lease_token'>,
    overrides: {
      cost?: number
      maxCost?: number
      descriptionInjected?: boolean
      descriptionMissing?: boolean
      suffix?: string
    } = {},
  ): Promise<Completion> {
    const suffix = overrides.suffix ?? claim.id
    const result = await db.query<Completion>(
      `select *
         from public.complete_intake_enhancement(
           $1, $2, $3, 1024, 768, $4, $5, 1280, 1280, $6, $7,
           $8, $9, $10, $11, $12
         )`,
      [
        claim.id,
        claim.lease_token,
        `intake/${suffix}/original.jpg`,
        `intake/${suffix}/generated.jpg`,
        `intake/${suffix}/thumb.webp`,
        'openai/gpt-image-2',
        `Resolved image prompt ${suffix}`,
        overrides.cost ?? 0.11,
        overrides.maxCost ?? 0.2,
        overrides.descriptionInjected ?? true,
        overrides.descriptionMissing ?? false,
        source,
      ],
    )
    return result.rows[0]!
  }

  it('caches descriptions once and completes immutable original/generated versions', async () => {
    const claim = await discoverAndClaim('cached-description.jpg')
    expect(claim.product_description).toBeNull()

    const description =
      'A refined pair of gold-tone earrings with luminous oval stones, pavé-set tops, balanced proportions, and a polished contemporary finish suited to elegant catalogue presentation.'
    const stored = await db.query<{
      product_description: string
      description_model: string
      description_cost_usd: string
    }>(
      `select product_description, description_model, description_cost_usd
         from public.store_intake_description($1, $2, $3, $4, $5, $6)`,
      [claim.id, claim.lease_token, description, 'openai/gpt-5.6-sol', 0.006, source],
    )
    expect(stored.rows[0]).toEqual({
      product_description: description,
      description_model: 'openai/gpt-5.6-sol',
      description_cost_usd: '0.006000',
    })

    const replay = await db.query<{
      product_description: string
      description_model: string
      description_cost_usd: string
    }>(
      `select product_description, description_model, description_cost_usd
         from public.store_intake_description($1, $2, $3, $4, $5, $6)`,
      [claim.id, claim.lease_token, 'This must not overwrite the cache.', 'other-model', 0.019, source],
    )
    expect(replay.rows[0]).toEqual(stored.rows[0])

    const completion = await complete(claim)
    expect(completion).toEqual(
      expect.objectContaining({
        id: claim.id,
        status: 'enhanced',
        attempts: 1,
        version_no: 1,
        cost_usd: '0.110000',
      }),
    )

    const versions = await db.query<{
      version_no: number
      kind: string
      width: number
      height: number
      is_selected: boolean
      parent_version_id: string | null
      description_injected: boolean
      description_missing: boolean
    }>(
      `select version_no, kind, width, height, is_selected, parent_version_id,
              description_injected, description_missing
         from public.image_versions
        where intake_file_id = $1
        order by version_no`,
      [claim.id],
    )
    expect(versions.rows).toEqual([
      {
        version_no: 0,
        kind: 'original',
        width: 1024,
        height: 768,
        is_selected: false,
        parent_version_id: null,
        description_injected: null,
        description_missing: null,
      },
      {
        version_no: 1,
        kind: 'generated',
        width: 1280,
        height: 1280,
        is_selected: true,
        parent_version_id: expect.any(String),
        description_injected: true,
        description_missing: false,
      },
    ])
  })

  it('rejects a stale completion and preserves the replacement worker result', async () => {
    const firstClaim = await discoverAndClaim('stale-worker.jpg')
    await db.query(
      `update public.intake_files
          set lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [firstClaim.id],
    )
    const swept = await db.query<{ sweep_expired_intake_leases: number }>(
      `select public.sweep_expired_intake_leases($1)`,
      [source],
    )
    expect(swept.rows[0]?.sweep_expired_intake_leases).toBe(1)

    const replacement = await db.query<Claim>(
      `select id, lease_token, attempts, product_description, description_missing_at
         from public.claim_intake_file(300)`,
    )
    expect(replacement.rows[0]?.id).toBe(firstClaim.id)
    expect(replacement.rows[0]?.lease_token).not.toBe(firstClaim.lease_token)

    await db.query('savepoint stale_completion')
    let staleCode: string | undefined
    try {
      await complete(firstClaim, { suffix: 'stale' })
    } catch (error) {
      staleCode = (error as { code?: string }).code
      await db.query('rollback to savepoint stale_completion')
    }
    expect(staleCode).toBe('55000')

    const winner = await complete(replacement.rows[0]!, {
      descriptionInjected: false,
      descriptionMissing: false,
      suffix: 'winner',
    })
    expect(winner.status).toBe('enhanced')

    const stored = await db.query<{ storage_key: string }>(
      `select storage_key
         from public.image_versions
        where intake_file_id = $1 and version_no = 1`,
      [firstClaim.id],
    )
    expect(stored.rows).toEqual([
      { storage_key: 'intake/winner/generated.jpg' },
    ])
  })

  it('keeps the fifth describe failure leased and completes without a description', async () => {
    const claim = await discoverAndClaim('description-fallback.jpg')
    await db.query(
      `update public.intake_files
          set attempts = 4
        where id = $1`,
      [claim.id],
    )

    const failure = await db.query<{
      status: string
      attempts: number
      proceed_without_description: boolean
    }>(
      `select status, attempts, proceed_without_description
         from public.record_description_failure($1, $2, $3, $4, $5, $6)`,
      [
        claim.id,
        claim.lease_token,
        'Description provider unavailable.',
        'description_provider_unavailable',
        '{"status":503}',
        source,
      ],
    )
    expect(failure.rows[0]).toEqual({
      status: 'enhancing',
      attempts: 5,
      proceed_without_description: true,
    })

    const afterFailure = await db.query<{
      description_missing: boolean
      lease_token: string
    }>(
      `select description_missing_at is not null as description_missing, lease_token
         from public.intake_files
        where id = $1`,
      [claim.id],
    )
    expect(afterFailure.rows[0]).toEqual({
      description_missing: true,
      lease_token: claim.lease_token,
    })

    const completion = await complete(claim, {
      descriptionInjected: false,
      descriptionMissing: true,
    })
    expect(completion).toEqual(
      expect.objectContaining({ status: 'enhanced', attempts: 5 }),
    )
  })

  it('degrades immediately after a description cost ceiling breach', async () => {
    const claim = await discoverAndClaim('description-over-budget.jpg')
    const failure = await db.query<{
      status: string
      attempts: number
      proceed_without_description: boolean
    }>(
      `select status, attempts, proceed_without_description
         from public.record_description_failure($1, $2, $3, $4, $5, $6)`,
      [
        claim.id,
        claim.lease_token,
        'Description cost $0.021 exceeded the $0.02 description ceiling.',
        'description_cost_ceiling_exceeded',
        '{"actual_cost_usd":0.021,"max_cost_usd":0.02}',
        source,
      ],
    )
    expect(failure.rows[0]).toEqual({
      status: 'enhancing',
      attempts: 1,
      proceed_without_description: true,
    })

    const completion = await complete(claim, {
      descriptionInjected: false,
      descriptionMissing: true,
    })
    expect(completion).toEqual(
      expect.objectContaining({ status: 'enhanced', attempts: 1 }),
    )
  })

  it('retains an over-ceiling image for review but permanently fails and selects nothing', async () => {
    const claim = await discoverAndClaim('over-budget.jpg')
    const completion = await complete(claim, {
      cost: 0.237891,
      maxCost: 0.2,
      descriptionInjected: false,
      descriptionMissing: false,
    })
    expect(completion).toEqual(
      expect.objectContaining({
        status: 'failed',
        attempts: 1,
        cost_usd: '0.237891',
      }),
    )

    const state = await db.query<{
      last_error: string
      last_error_code: string
      last_error_detail: string
      error_class: string
      selected_count: string
      version_count: string
    }>(
      `select f.last_error, f.last_error_code, f.last_error_detail, f.error_class,
              count(iv.id) filter (where iv.is_selected)::text as selected_count,
              count(iv.id)::text as version_count
         from public.intake_files as f
         left join public.image_versions as iv on iv.intake_file_id = f.id
        where f.id = $1
        group by f.id`,
      [claim.id],
    )
    expect(state.rows[0]).toEqual({
      last_error:
        'Image generation cost $0.237891 exceeded the $0.2 per-image ceiling. The version was retained for review and will not be retried.',
      last_error_code: 'image_cost_ceiling_exceeded',
      last_error_detail: expect.stringContaining('"actual_cost_usd": 0.237891'),
      error_class: 'permanent',
      selected_count: '0',
      version_count: '2',
    })
  })
})
