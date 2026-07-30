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

async function fixture() {
  const prompt = await db.query<{ id: string; model: string }>(
    `select id, model
       from public.prompts
      where kind = 'image' and is_default and archived_at is null`,
  )
  const intake = await db.query<{ id: string }>(
    `insert into public.intake_files (
       drive_file_id,
       filename,
       bytes,
       mime_type,
       status,
       enhanced_at,
       product_description,
       presentation_class,
       presentation_fallback,
       description_model,
       described_at,
       description_cost_usd
     )
     values (
       'phase5-redo-' || gen_random_uuid(),
       'phase5-redo.png',
       1234,
       'image/png',
       'enhanced',
       now(),
       'A factual cached description reused by the image-only redo.',
       'flat-curve',
       false,
       'openai/gpt-5.6-sol',
       now(),
       0.015
     )
     returning id`,
  )
  const intakeId = intake.rows[0]!.id
  const original = await db.query<{ id: string }>(
    `insert into public.image_versions (
       intake_file_id, version_no, kind, storage_key, width, height, is_selected
     )
     values (
       $1::uuid,
       0,
       'original',
       'originals/' || $1::uuid::text || '.png',
       600,
       400,
       false
     )
     returning id`,
    [intakeId],
  )
  await db.query(
    `insert into public.image_versions (
       intake_file_id, version_no, kind, storage_key, thumb_key, width, height,
       prompt_text, model, cost_usd, parent_version_id, is_selected,
       description_injected, description_missing
     )
     values (
       $1::uuid, 1, 'generated', 'versions/' || $1::uuid::text || '/v1.png',
       'versions/' || $1::uuid::text || '/v1_thumb.webp', 1280, 1280,
       'version one prompt', $2, 0.07, $3, true, true, false
     )`,
    [intakeId, prompt.rows[0]!.model, original.rows[0]!.id],
  )
  return { intakeId, promptId: prompt.rows[0]!.id, model: prompt.rows[0]!.model }
}

async function enqueue(intakeId: string, promptId: string) {
  const result = await db.query<{ enqueue_image_redo: string }>(
    `select public.enqueue_image_redo($1, $2, $3, true, false, $4)`,
    [
      intakeId,
      promptId,
      'Resolved image prompt with the cached description and flat-curve composition.',
      'test:phase5-redo',
    ],
  )
  return result.rows[0]!.enqueue_image_redo
}

describe('deployed durable image redo queue', () => {
  it('reserves one job/version, audits the operator and appends an unselected result', async () => {
    const { intakeId, promptId, model } = await fixture()
    const jobId = await enqueue(intakeId, promptId)
    expect(await enqueue(intakeId, promptId)).toBe(jobId)

    const queued = await db.query<{
      version_no: number
      model: string
      created_by: string
    }>(
      `select version_no, model, created_by
         from public.image_redo_jobs
        where id = $1`,
      [jobId],
    )
    expect(queued.rows[0]).toEqual({
      version_no: 2,
      model,
      created_by: 'test:phase5-redo',
    })

    const claim = await db.query<{
      id: string
      lease_token: string
      generation_started_at: Date | null
    }>(`select * from public.claim_image_redo(300, $1)`, [jobId])
    expect(claim.rowCount).toBe(1)
    const leaseToken = claim.rows[0]!.lease_token
    expect(claim.rows[0]!.generation_started_at).toBeNull()

    await db.query(`select public.mark_image_redo_generation_started($1, $2)`, [
      jobId,
      leaseToken,
    ])
    const completed = await db.query<{
      status: string
      image_version_id: string
      version_no: number
      cost_usd: string
    }>(
      `select * from public.complete_image_redo(
         $1, $2, $3, $4, 1280, 1280, $5, 0.073376, 0.20, 'test:redo-worker'
       )`,
      [
        jobId,
        leaseToken,
        `versions/${intakeId}/v2.png`,
        `versions/${intakeId}/v2_thumb.webp`,
        model,
      ],
    )
    expect(completed.rows[0]).toMatchObject({
      status: 'completed',
      version_no: 2,
      cost_usd: '0.073376',
    })

    const versions = await db.query<{
      id: string
      version_no: number
      is_selected: boolean
      prompt_text: string
      model: string
      cost_usd: string
      parent_version_id: string
    }>(
      `select id, version_no, is_selected, prompt_text, model, cost_usd, parent_version_id
         from public.image_versions
        where intake_file_id = $1
        order by version_no`,
      [intakeId],
    )
    expect(versions.rows.map((row) => row.version_no)).toEqual([0, 1, 2])
    expect(versions.rows[1]!.is_selected).toBe(true)
    expect(versions.rows[2]).toMatchObject({
      version_no: 2,
      is_selected: false,
      prompt_text:
        'Resolved image prompt with the cached description and flat-curve composition.',
      model,
      cost_usd: '0.073376',
      parent_version_id: versions.rows[0]!.id,
    })

    const events = await db.query<{ event: string; actor: string }>(
      `select event, actor
         from public.events
        where entity_id = $1
        order by id`,
      [jobId],
    )
    expect(events.rows.map((row) => row.event)).toEqual([
      'image.redo_queued',
      'image.redo_claimed',
      'image.redo_completed',
    ])
    expect(events.rows[0]!.actor).toBe('test:phase5-redo')
  })

  it('reclaims an expired started job with the paid-call marker intact', async () => {
    const { intakeId, promptId } = await fixture()
    const jobId = await enqueue(intakeId, promptId)
    const first = await db.query<{ lease_token: string }>(
      `select lease_token from public.claim_image_redo(300, $1)`,
      [jobId],
    )
    await db.query(`select public.mark_image_redo_generation_started($1, $2)`, [
      jobId,
      first.rows[0]!.lease_token,
    ])
    await db.query(
      `update public.image_redo_jobs
          set lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [jobId],
    )

    const reclaimed = await db.query<{
      lease_token: string
      generation_started_at: Date | null
    }>(`select lease_token, generation_started_at from public.claim_image_redo(300, $1)`, [
      jobId,
    ])
    expect(reclaimed.rowCount).toBe(1)
    expect(reclaimed.rows[0]!.lease_token).not.toBe(first.rows[0]!.lease_token)
    expect(reclaimed.rows[0]!.generation_started_at).not.toBeNull()
  })
})
