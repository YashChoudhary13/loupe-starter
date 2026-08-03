import { randomUUID } from 'node:crypto'

import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pgClient } from '../scripts/lib/pg'

describe('manual ready-image intake', () => {
  let db: Client
  const actor = 'test:manual-upload@example.com'

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

  async function pendingUpload() {
    const id = randomUUID()
    await db.query(
      `insert into public.manual_uploads (
         id, filename, mime_type, bytes, storage_key, created_by
       ) values ($1, $2, 'image/jpeg', 1234, $3, $4)`,
      [id, `ready-${id}.jpg`, `manual/${id}/original.jpg`, actor],
    )
    return id
  }

  async function finalizedUpload() {
    const uploadId = await pendingUpload()
    const result = await db.query<{ intake_id: string }>(
      `select public.finalize_manual_image_upload($1, $2, 1600, 1200, $3, $4) as intake_id`,
      [uploadId, `manual/${uploadId}/thumb.webp`, '0123456789abcdef', actor],
    )
    return { uploadId, intakeId: result.rows[0]!.intake_id }
  }

  it('atomically exposes one selected pristine original and is idempotent', async () => {
    const uploadId = await pendingUpload()
    const args = [
      uploadId,
      `manual/${uploadId}/thumb.webp`,
      1600,
      1200,
      '0123456789abcdef',
      actor,
    ] as const

    const first = await db.query<{ intake_id: string }>(
      `select public.finalize_manual_image_upload($1, $2, $3, $4, $5, $6) as intake_id`,
      [...args],
    )
    const second = await db.query<{ intake_id: string }>(
      `select public.finalize_manual_image_upload($1, $2, $3, $4, $5, $6) as intake_id`,
      [...args],
    )
    expect(second.rows[0]?.intake_id).toBe(first.rows[0]?.intake_id)

    const intake = await db.query<{
      drive_file_id: string
      source: string
      status: string
      attempts: number
      phash: string
      description_missing_at: Date | null
    }>(
      `select drive_file_id, source, status, attempts, phash, description_missing_at
         from public.intake_files where id = $1`,
      [first.rows[0]!.intake_id],
    )
    expect(intake.rows[0]).toMatchObject({
      drive_file_id: `manual:${uploadId}`,
      source: 'manual',
      status: 'enhanced',
      attempts: 0,
      phash: '0123456789abcdef',
      description_missing_at: null,
    })

    const versions = await db.query<{
      version_no: number
      kind: string
      storage_key: string
      thumb_key: string
      model: string | null
      prompt_text: string | null
      cost_usd: string | null
      is_selected: boolean
    }>(
      `select version_no, kind, storage_key, thumb_key, model, prompt_text,
              cost_usd, is_selected
         from public.image_versions where intake_file_id = $1`,
      [first.rows[0]!.intake_id],
    )
    expect(versions.rows).toEqual([
      {
        version_no: 0,
        kind: 'original',
        storage_key: `manual/${uploadId}/original.jpg`,
        thumb_key: `manual/${uploadId}/thumb.webp`,
        model: null,
        prompt_text: null,
        cost_usd: null,
        is_selected: true,
      },
    ])

    const audit = await db.query<{ event: string; ai_bypassed: boolean }>(
      `select event, (detail->>'ai_bypassed')::boolean as ai_bypassed
         from public.events
        where entity_id = $1 and event = 'intake.manual_uploaded'`,
      [first.rows[0]!.intake_id],
    )
    expect(audit.rows).toEqual([{ event: 'intake.manual_uploaded', ai_bypassed: true }])
  })

  it('refuses a different operator before creating an intake row', async () => {
    const uploadId = await pendingUpload()
    await db.query('savepoint wrong_actor_probe')
    await expect(
      db.query(
        `select public.finalize_manual_image_upload($1, $2, 100, 100, $3, $4)`,
        [uploadId, `manual/${uploadId}/thumb.webp`, 'ffffffffffffffff', 'other@example.com'],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await db.query('rollback to savepoint wrong_actor_probe')

    const count = await db.query<{ count: string }>(
      `select count(*) from public.intake_files where drive_file_id = $1`,
      [`manual:${uploadId}`],
    )
    expect(count.rows[0]?.count).toBe('0')
  })

  it('settles an optional manual AI request onto the durable image-only redo path', async () => {
    const { intakeId } = await finalizedUpload()

    const first = await db.query<{ prepared: boolean }>(
      `select public.prepare_manual_image_redo($1, $2) as prepared`,
      [intakeId, actor],
    )
    const second = await db.query<{ prepared: boolean }>(
      `select public.prepare_manual_image_redo($1, $2) as prepared`,
      [intakeId, actor],
    )
    expect(first.rows[0]?.prepared).toBe(true)
    expect(second.rows[0]?.prepared).toBe(true)

    const state = await db.query<{
      description_missing_at: Date | null
      presentation_class: string | null
      presentation_fallback: boolean
      presentation_fallback_reason: string | null
    }>(
      `select description_missing_at, presentation_class, presentation_fallback,
              presentation_fallback_reason
         from public.intake_files where id = $1`,
      [intakeId],
    )
    expect(state.rows[0]).toMatchObject({
      presentation_class: 'flat-curve',
      presentation_fallback: true,
      presentation_fallback_reason: 'manual_ready_upload_image_only_ai',
    })
    expect(state.rows[0]?.description_missing_at).not.toBeNull()

    const audit = await db.query<{ count: string }>(
      `select count(*) from public.events
        where entity_id = $1 and event = 'intake.manual_ai_enabled'`,
      [intakeId],
    )
    expect(audit.rows[0]?.count).toBe('1')
  })

  it('deletes an ungrouped manual upload and its completed handshake', async () => {
    const { uploadId, intakeId } = await finalizedUpload()

    await db.query(`select public.prepare_console_photo_delete($1, $2)`, [intakeId, actor])
    await db.query(`select public.discard_intake_file($1, $2)`, [intakeId, actor])

    const intake = await db.query(`select id from public.intake_files where id = $1`, [intakeId])
    const upload = await db.query(`select id from public.manual_uploads where id = $1`, [uploadId])
    expect(intake.rowCount).toBe(0)
    expect(upload.rowCount).toBe(0)
  })

  it('refuses console deletion after the photograph has reached a Shopify draft', async () => {
    const { intakeId } = await finalizedUpload()
    const category = await db.query<{ id: string }>(
      `select id from public.categories where sku_prefix = 'NK'`,
    )
    const draft = await db.query<{ id: string }>(
      `select public.create_product_draft($1, array[$2]::uuid[], $3) as id`,
      [category.rows[0]!.id, intakeId, actor],
    )

    await db.query('savepoint grouped_delete_guard')
    await expect(
      db.query(`select public.prepare_console_photo_delete($1, $2)`, [intakeId, actor]),
    ).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint grouped_delete_guard')

    await db.query(
      `select * from public.reserve_draft_identity($1, $2, false)`,
      [draft.rows[0]!.id, actor],
    )
    await db.query(
      `select public.record_draft_shopify_product($1, $2, $3)`,
      [draft.rows[0]!.id, `gid://shopify/Product/manual-delete-${randomUUID()}`, actor],
    )
    await db.query(`select public.detach_intake_file($1, $2, $3)`, [
      draft.rows[0]!.id,
      intakeId,
      actor,
    ])

    await db.query('savepoint shopify_delete_guard')
    await expect(
      db.query(`select public.prepare_console_photo_delete($1, $2)`, [intakeId, actor]),
    ).rejects.toMatchObject({ code: '55000' })
    await db.query('rollback to savepoint shopify_delete_guard')

    const row = await db.query<{ status: string }>(
      `select status from public.intake_files where id = $1`,
      [intakeId],
    )
    expect(row.rows[0]?.status).toBe('enhanced')
  })
})
