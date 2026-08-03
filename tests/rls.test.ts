/**
 * The browser client must be able to reach nothing.
 *
 * CLAUDE.md hard rule 7. Every table has RLS enabled with zero policies, so the
 * publishable key — which is shipped to the browser and is therefore public —
 * gets no rows and can write none. This test is what stops that being true only
 * by accident.
 */
import { describe, expect, it } from 'vitest'

import { TABLES } from '../src/lib/tables'
import { publishableClient, serviceClient, SUPABASE_URL } from './helpers/db'

describe('publishable key — read access', () => {
  it.each(TABLES)('cannot read %s', async (table) => {
    const { data, error } = await publishableClient().from(table).select('*').limit(1)

    // Either an explicit permission error, or an empty result. Both are a pass;
    // a row is not.
    if (error === null) {
      expect(data, `${table} returned rows to an anonymous browser client`).toEqual([])
    } else {
      expect(data).toBeNull()
    }
  })
})

describe('publishable key — write access', () => {
  it('cannot insert a category', async () => {
    const { error } = await publishableClient()
      .from('categories')
      .insert({ name: 'rls probe', sku_prefix: 'ZZ', title_pattern: 'X {n}', shopify_tag: 'zz' })
    expect(error, 'an anonymous insert must be refused').not.toBeNull()

    const { data } = await serviceClient().from('categories').select('sku_prefix').eq('sku_prefix', 'ZZ')
    expect(data, 'nothing may have been written').toEqual([])
  })

  it('cannot move a SKU counter', async () => {
    const before = await serviceClient()
      .from('sku_counters')
      .select('last_number')
      .eq('sku_prefix', 'NK')
      .single()

    await publishableClient().from('sku_counters').update({ last_number: 9999 }).eq('sku_prefix', 'NK')

    const after = await serviceClient()
      .from('sku_counters')
      .select('last_number')
      .eq('sku_prefix', 'NK')
      .single()

    expect((after.data as { last_number: number }).last_number).toBe(
      (before.data as { last_number: number }).last_number,
    )
  })

  it('cannot create sync cursor state', async () => {
    const key = `rls-probe-${Date.now()}`
    const { error } = await publishableClient().from('sync_state').insert({ key, value: 'rewind' })
    expect(error, 'an anonymous client must not create or overwrite a Drive cursor').not.toBeNull()

    const { data } = await serviceClient().from('sync_state').select('key').eq('key', key)
    expect(data, 'nothing may have been written').toEqual([])
  })
})

describe('server-only functions are not callable without the service role', () => {
  // Burning SKU numbers from the browser would open gaps in the sequence for
  // free — and reserving an identity or marking a draft published from the
  // browser would let anyone put a product on the live store. EXECUTE is revoked
  // from PUBLIC, anon and authenticated on every one of these.
  async function anonymousRpc(fn: string, body: Record<string, unknown>): Promise<Response> {
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
    return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('refuses an anonymous next_sku call', async () => {
    const res = await anonymousRpc('next_sku', { p_prefix: 'NK' })
    expect(res.ok, `anonymous next_sku call returned HTTP ${res.status}`).toBe(false)
    expect([401, 403, 404]).toContain(res.status)
  })

  const phase2Functions: [string, Record<string, unknown>][] = [
    ['raise_sku_counter', { p_prefix: 'NK', p_to: 999_999 }],
    ['reserve_draft_identity', { p_draft_id: '00000000-0000-0000-0000-000000000000' }],
    ['mark_draft_published', {
      p_draft_id: '00000000-0000-0000-0000-000000000000',
      p_shopify_product_id: 'gid://shopify/Product/1',
    }],
    ['mark_draft_failed', {
      p_draft_id: '00000000-0000-0000-0000-000000000000',
      p_error: 'anonymous',
    }],
    ['sync_product_draft_option_stock', {}],
  ]

  for (const [fn, body] of phase2Functions) {
    it(`refuses an anonymous ${fn} call`, async () => {
      const res = await anonymousRpc(fn, body)
      expect(res.ok, `anonymous ${fn} call returned HTTP ${res.status}`).toBe(false)
      expect([401, 403, 404]).toContain(res.status)
    })
  }

  const phase3Functions: [string, Record<string, unknown>][] = [
    ['discover_intake_file', {
      p_drive_file_id: '',
      p_filename: 'anonymous.jpg',
      p_drive_md5: null,
      p_bytes: 1,
      p_mime_type: 'image/jpeg',
      p_source: 'rls-probe',
    }],
    ['claim_intake_file', { p_lease_seconds: 0 }],
    ['record_intake_failure', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_error: 'anonymous',
      p_error_code: 'anonymous',
      p_error_class: 'permanent',
    }],
    ['sweep_expired_intake_leases', { p_source: 'rls-probe' }],
    ['claim_sync_state', { p_key: 'rls-probe', p_lease_seconds: 0 }],
    ['complete_sync_state', {
      p_key: 'rls-probe',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_value: 'rewind',
    }],
    ['release_sync_state', {
      p_key: 'rls-probe',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
    }],
    ['assert_intake_lease', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
    }],
    ['store_intake_description', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_description: 'anonymous',
      p_presentation_class: 'flat-curve',
      p_model: 'anonymous',
      p_cost_usd: 0,
      p_source: 'rls-probe',
    }],
    ['ensure_intake_presentation_fallback', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_reason: 'anonymous',
      p_source: 'rls-probe',
    }],
    ['record_description_failure', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_error: 'anonymous',
      p_error_code: 'anonymous',
      p_error_detail: 'anonymous',
      p_source: 'rls-probe',
    }],
    ['complete_intake_enhancement', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_original_storage_key: 'anonymous/original.jpg',
      p_original_width: 1,
      p_original_height: 1,
      p_generated_storage_key: 'anonymous/generated.jpg',
      p_thumb_key: 'anonymous/thumb.webp',
      p_generated_width: 1280,
      p_generated_height: 1280,
      p_model: 'anonymous',
      p_prompt_text: 'anonymous',
      p_cost_usd: 0,
      p_max_cost_usd: 0.2,
      p_description_injected: false,
      p_description_missing: true,
      p_source: 'rls-probe',
    }],
    ['finalize_manual_image_upload', {
      p_upload_id: '00000000-0000-0000-0000-000000000000',
      p_thumb_key: 'manual/anonymous/thumb.webp',
      p_width: 1,
      p_height: 1,
      p_phash: '0000000000000000',
      p_actor: 'anonymous',
    }],
    ['validate_prompt_body', {
      p_kind: 'describe',
      p_body: 'anonymous',
    }],
    ['create_prompt_version', {
      p_kind: 'describe',
      p_name: 'anonymous',
      p_body: 'anonymous',
      p_model: 'openai/gpt-5.6-sol',
      p_actor: 'anonymous',
    }],
    ['promote_prompt_version', {
      p_prompt_id: '00000000-0000-0000-0000-000000000000',
      p_actor: 'anonymous',
    }],
    ['promote_prompt_preset', {
      p_slug: 'anonymous',
      p_actor: 'anonymous',
    }],
    ['select_prompt_model', {
      p_kind: 'describe',
      p_model: 'openai/gpt-5.6-sol',
      p_actor: 'anonymous',
    }],
    ['enqueue_image_redo', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_prompt_id: '00000000-0000-0000-0000-000000000000',
      p_prompt_text: 'anonymous',
      p_description_injected: false,
      p_description_missing: true,
      p_actor: 'anonymous',
    }],
    ['claim_image_redo', {
      p_lease_seconds: 300,
      p_job_id: null,
    }],
    ['assert_image_redo_lease', {
      p_job_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
    }],
    ['mark_image_redo_generation_started', {
      p_job_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
    }],
    ['complete_image_redo', {
      p_job_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_storage_key: 'anonymous/v2.png',
      p_thumb_key: 'anonymous/v2_thumb.webp',
      p_width: 1280,
      p_height: 1280,
      p_actual_model: 'anonymous',
      p_cost_usd: 0,
      p_max_cost_usd: 0.2,
      p_source: 'anonymous',
    }],
    ['record_image_redo_failure', {
      p_job_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_error: 'anonymous',
      p_error_code: 'anonymous',
      p_retryable: false,
      p_source: 'anonymous',
    }],
    ['store_intake_phash', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_phash: '0000000000000000',
      p_source: 'anonymous',
    }],
    ['retry_intake_file', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_actor: 'anonymous',
    }],
    ['skip_intake_file', {
      p_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_actor: 'anonymous',
    }],
    ['review_duplicate_pair', {
      p_left_intake_file_id: '00000000-0000-0000-0000-000000000000',
      p_right_intake_file_id: '00000000-0000-0000-0000-000000000001',
      p_decision: 'dismissed',
      p_duplicate_intake_file_id: null,
      p_distance: 0,
      p_actor: 'anonymous',
    }],
    ['claim_shopify_reconciliation', {
      p_actor: 'anonymous',
      p_lease_seconds: 300,
    }],
    ['assert_shopify_reconciliation_lease', {
      p_run_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
    }],
    ['complete_shopify_reconciliation', {
      p_run_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_total_products: 0,
      p_issues: [],
      p_source: 'anonymous',
    }],
    ['fail_shopify_reconciliation', {
      p_run_id: '00000000-0000-0000-0000-000000000000',
      p_lease_token: '00000000-0000-0000-0000-000000000000',
      p_error: 'anonymous',
      p_source: 'anonymous',
    }],
  ]

  for (const [fn, body] of phase3Functions) {
    it(`refuses an anonymous ${fn} call`, async () => {
      const res = await anonymousRpc(fn, body)
      expect(res.ok, `anonymous ${fn} call returned HTTP ${res.status}`).toBe(false)
      // 400 would mean the function executed and merely rejected our deliberately
      // invalid probe. Only authentication/permission/not-exposed outcomes pass.
      expect([401, 403, 404]).toContain(res.status)
    })
  }

  it('leaves the NK counter untouched after all of that', async () => {
    // raise_sku_counter(NK, 999999) would be catastrophic if it had gone through.
    const { data } = await serviceClient()
      .from('sku_counters')
      .select('last_number')
      .eq('sku_prefix', 'NK')
      .single()
    expect((data as { last_number: number }).last_number).toBeLessThan(999_999)
  })
})
