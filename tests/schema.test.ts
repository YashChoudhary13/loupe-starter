/**
 * Schema invariants.
 *
 * These assert against the DEPLOYED database, not the migration files. The two
 * drift the moment somebody edits something in the Supabase SQL editor, and the
 * things that drift most quietly — a dropped index, an RLS flag turned off to
 * debug something at 1am — are exactly the ones nothing else notices.
 */
import { createHash } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import { TABLES } from '../src/lib/tables'
import { serviceClient } from './helpers/db'

interface SchemaReport {
  tables: { name: string; rls_enabled: boolean; policy_count: number }[]
  indexes: string[]
  enums: Record<string, string[]>
  functions: string[]
  columns: Record<string, string>
  extensions: Record<string, string>
  function_execute: Record<
    string,
    { anon: boolean; authenticated: boolean; service_role: boolean }
  >
}

let report: SchemaReport

beforeAll(async () => {
  const { data, error } = await serviceClient().rpc('_loupe_schema_report')
  if (error) throw new Error(`schema report unavailable: ${error.message}`)
  report = data as SchemaReport
})

describe('tables', () => {
  it('matches src/lib/tables.ts exactly, so /health cannot miss one', () => {
    const inDb = report.tables.map((t) => t.name).sort()
    expect(inDb).toEqual([...TABLES].sort())
  })
})

describe('row level security — CLAUDE.md hard rule 7', () => {
  it('is enabled on every table', () => {
    const unprotected = report.tables.filter((t) => !t.rls_enabled).map((t) => t.name)
    expect(unprotected, 'these tables would be readable with the publishable key').toEqual([])
  })

  it('has no policies at all, which is what makes it deny-all', () => {
    const withPolicies = report.tables.filter((t) => t.policy_count > 0)
    expect(
      withPolicies,
      'a policy means something is reachable from the browser — that needs a deliberate decision, not a default',
    ).toEqual([])
  })
})

describe('indexes the system actually queries on', () => {
  // Named in docs/phases/PHASE-1-foundation.md. Losing one does not fail
  // anything — it just makes the tracking page quietly slower every month.
  const required = [
    'intake_files_status_discovered_at_idx',
    'intake_files_expired_lease_idx',
    'intake_files_ready_queue_idx',
    'intake_files_phash_idx',
    'image_redo_claim_idx',
    'image_redo_one_active_per_intake',
    'duplicate_reviews_duplicate_target_idx',
    'shopify_reconciliation_one_active',
    'shopify_reconciliation_issues_run_idx',
    'product_drafts_status_idx',
    'events_entity_idx',
  ]

  it.each(required)('%s exists', (name) => {
    expect(report.indexes).toContain(name)
  })

  it('enforces SKU and handle uniqueness — the RS221 backstop', () => {
    expect(report.indexes).toContain('product_drafts_reserved_sku_key')
    expect(report.indexes).toContain('product_drafts_reserved_handle_key')
  })

  it('enforces one selected image version per intake file', () => {
    expect(report.indexes).toContain('image_versions_one_selected_per_file')
  })
})

describe('closed vocabularies', () => {
  it('intake_status holds the full lifecycle', () => {
    expect(report.enums.intake_status).toEqual([
      'discovered',
      'enhancing',
      'enhanced',
      'grouped',
      'published',
      'failed',
      'duplicate',
      'skipped',
    ])
  })

  it('error_class distinguishes retryable from permanent', () => {
    expect(report.enums.error_class).toEqual(['retryable', 'permanent'])
  })

  it('draft_status includes the crash-visible publishing state', () => {
    expect(report.enums.draft_status).toEqual(['assembling', 'publishing', 'published', 'failed'])
  })

  it('prompt_kind separates the two model stages', () => {
    expect(report.enums.prompt_kind).toEqual(['describe', 'image'])
  })

  it('presentation_class is the exact closed staging vocabulary', () => {
    expect(report.enums.presentation_class).toEqual([
      'pair-upright',
      'flat-curve',
      'standing-three-quarter',
      'angled-band',
      'flat-arc',
      'tray-grid',
    ])
  })

  it('image_redo_status has only durable queue states', () => {
    expect(report.enums.image_redo_status).toEqual([
      'queued',
      'processing',
      'completed',
      'failed',
    ])
  })

  it('has exact duplicate review and reconciliation states', () => {
    expect(report.enums.duplicate_review_decision).toEqual(['dismissed', 'duplicate'])
    expect(report.enums.shopify_reconciliation_status).toEqual([
      'running',
      'completed',
      'failed',
    ])
  })
})

describe('conventions', () => {
  it('money is an integer number of paise, never a float', () => {
    expect(report.columns['product_drafts.price_paise']).toBe('integer')
  })

  it('every timestamp column is timestamptz', () => {
    const wrong = Object.entries(report.columns).filter(
      ([, type]) => type === 'timestamp without time zone',
    )
    expect(wrong, 'CLAUDE.md: timestamps are timestamptz, UTC').toEqual([])
  })

  it('next_sku is present', () => {
    expect(report.functions).toContain('next_sku')
  })

  it('has the Phase 3A queue and cursor functions deployed', () => {
    for (const fn of [
      'discover_intake_file',
      'claim_intake_file',
      'record_intake_failure',
      'sweep_expired_intake_leases',
      'claim_sync_state',
      'complete_sync_state',
      'release_sync_state',
    ]) {
      expect(report.functions, `${fn} is missing from the deployed schema`).toContain(fn)
    }
  })

  it('has the fenced Phase 3B description and completion functions deployed', () => {
    for (const fn of [
      'assert_intake_lease',
      'store_intake_description',
      'ensure_intake_presentation_fallback',
      'record_description_failure',
      'complete_intake_enhancement',
    ]) {
      expect(report.functions, `${fn} is missing from the deployed schema`).toContain(fn)
    }
  })

  it('has the Phase 5 prompt and redo functions deployed', () => {
    for (const fn of [
      'validate_prompt_body',
      'create_prompt_version',
      'promote_prompt_version',
      'promote_prompt_preset',
      'select_prompt_model',
      'enqueue_image_redo',
      'claim_image_redo',
      'assert_image_redo_lease',
      'mark_image_redo_generation_started',
      'complete_image_redo',
      'record_image_redo_failure',
    ]) {
      expect(report.functions, `${fn} is missing from the deployed schema`).toContain(fn)
    }
  })

  it('has the Phase 6 tracking and reconciliation functions deployed', () => {
    for (const fn of [
      'store_intake_phash',
      'retry_intake_file',
      'skip_intake_file',
      'review_duplicate_pair',
      'claim_shopify_reconciliation',
      'assert_shopify_reconciliation_lease',
      'complete_shopify_reconciliation',
      'fail_shopify_reconciliation',
    ]) {
      expect(report.functions, `${fn} is missing from the deployed schema`).toContain(fn)
    }
  })

  it('the broken control fixture is not left loaded in the database', () => {
    expect(
      report.functions,
      '_loupe_naive_next_sku is a deliberately broken counter — it must never be present outside a control run',
    ).not.toContain('_loupe_naive_next_sku')
  })
})

describe('Phase 3A database capabilities', () => {
  it('installs the worker extensions, with pg_cron in pg_catalog', () => {
    expect(report.extensions.pg_cron).toBe('pg_catalog')
    expect(report.extensions.pg_net).toBeDefined()
  })

  it('stores MIME, retry and raw error metadata on intake files', () => {
    expect(report.columns['intake_files.mime_type']).toBe('text')
    expect(report.columns['intake_files.next_attempt_at']).toBe('timestamp with time zone')
    expect(report.columns['intake_files.last_error_detail']).toBe('text')
    expect(report.columns['intake_files.lease_token']).toBe('uuid')
    expect(report.columns['intake_files.presentation_class']).toBe(
      'public.presentation_class',
    )
    expect(report.columns['intake_files.presentation_fallback']).toBe('boolean')
    expect(report.columns['intake_files.presentation_fallback_reason']).toBe('text')
  })

  it('stores an opaque cursor and UUID lease on sync_state', () => {
    expect(report.columns['sync_state.key']).toBe('text')
    expect(report.columns['sync_state.value']).toBe('text')
    expect(report.columns['sync_state.lease_token']).toBe('uuid')
    expect(report.columns['sync_state.lease_expires_at']).toBe('timestamp with time zone')
  })

  it('keeps every Phase 3A RPC service-role-only', () => {
    const phase3Functions = [
      'discover_intake_file',
      'claim_intake_file',
      'record_intake_failure',
      'sweep_expired_intake_leases',
      'claim_sync_state',
      'complete_sync_state',
      'release_sync_state',
    ]

    for (const fn of phase3Functions) {
      const matches = Object.entries(report.function_execute).filter(([signature]) =>
        signature.startsWith(`${fn}(`) || signature.startsWith(`public.${fn}(`),
      )
      expect(matches, `${fn} must have exactly one deployed signature`).toHaveLength(1)
      expect(matches[0]?.[1]).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      })
    }
  })

  it('keeps every Phase 3B RPC service-role-only', () => {
    for (const fn of [
      'assert_intake_lease',
      'store_intake_description',
      'ensure_intake_presentation_fallback',
      'record_description_failure',
      'complete_intake_enhancement',
    ]) {
      const matches = Object.entries(report.function_execute).filter(([signature]) =>
        signature.startsWith(`${fn}(`) || signature.startsWith(`public.${fn}(`),
      )
      expect(matches, `${fn} must have exactly one deployed signature`).toHaveLength(1)
      expect(matches[0]?.[1]).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      })
    }
  })

  it('keeps every Phase 5 RPC service-role-only', () => {
    for (const fn of [
      'validate_prompt_body',
      'create_prompt_version',
      'promote_prompt_version',
      'promote_prompt_preset',
      'select_prompt_model',
      'enqueue_image_redo',
      'claim_image_redo',
      'assert_image_redo_lease',
      'mark_image_redo_generation_started',
      'complete_image_redo',
      'record_image_redo_failure',
    ]) {
      const matches = Object.entries(report.function_execute).filter(([signature]) =>
        signature.startsWith(`${fn}(`) || signature.startsWith(`public.${fn}(`),
      )
      expect(matches, `${fn} must have exactly one deployed signature`).toHaveLength(1)
      expect(matches[0]?.[1]).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      })
    }
  })

  it('keeps every Phase 6 RPC service-role-only', () => {
    for (const fn of [
      'store_intake_phash',
      'retry_intake_file',
      'skip_intake_file',
      'review_duplicate_pair',
      'claim_shopify_reconciliation',
      'assert_shopify_reconciliation_lease',
      'complete_shopify_reconciliation',
      'fail_shopify_reconciliation',
    ]) {
      const matches = Object.entries(report.function_execute).filter(([signature]) =>
        signature.startsWith(`${fn}(`) || signature.startsWith(`public.${fn}(`),
      )
      expect(matches, `${fn} must have exactly one deployed signature`).toHaveLength(1)
      expect(matches[0]?.[1]).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      })
    }
  })
})

describe('seed data', () => {
  it('has the confirmed categories with the live store’s exact tags', async () => {
    const { data, error } = await serviceClient()
      .from('categories')
      .select('name, sku_prefix, title_pattern, shopify_tag')
      .order('sort_order')
    expect(error).toBeNull()

    // Tags are inconsistently cased in the live store. Collections are tag-driven,
    // so "tidying" one silently drops the product out of its collection.
    //
    // Nose Pins' tag was NULL from Phase 2 until 2026-08-01, when all 20 live
    // Nose Pins were read and found to carry exactly one tag: NP.
    //
    // Watches, Hand Chains, Indian Jewellery and Hair Accessories were added
    // the same day from the live catalogue, each with a tag that is unanimous
    // across every live product of that prefix.
    expect(data).toEqual([
      { name: 'Necklaces', sku_prefix: 'NK', title_pattern: 'Necklace {n}', shopify_tag: 'Necklace' },
      { name: 'Earrings', sku_prefix: 'ER', title_pattern: 'Earrings {n}', shopify_tag: 'earrings' },
      { name: 'Kada Bracelets', sku_prefix: 'BK', title_pattern: 'Bracelet Kada {n}', shopify_tag: 'kada' },
      { name: 'Chain Bracelets', sku_prefix: 'CB', title_pattern: 'Chain Bracelet {n}', shopify_tag: 'cb' },
      { name: 'Rings', sku_prefix: 'RS', title_pattern: 'Rings {n}', shopify_tag: 'Rings' },
      { name: 'Anklets', sku_prefix: 'AK', title_pattern: 'Anklets {n} (Single Piece)', shopify_tag: 'anklets' },
      { name: 'Nose Pins', sku_prefix: 'NP', title_pattern: 'Nose Pin {n}', shopify_tag: 'NP' },
      { name: 'Watches', sku_prefix: 'WH', title_pattern: 'Watch {n}', shopify_tag: 'watch' },
      { name: 'Hand Chains', sku_prefix: 'HC', title_pattern: 'Hand Chain {n}', shopify_tag: 'Hand Chain' },
      { name: 'Indian Jewellery', sku_prefix: 'INJ', title_pattern: 'Indian Pendant Sets {n}', shopify_tag: 'INJ' },
      { name: 'Hair Accessories', sku_prefix: 'HA', title_pattern: 'Hairband {n}', shopify_tag: 'HA' },
    ])
  })

  it('invents no prefix for the categories still unresolved on the live store', async () => {
    // The live store also uses S, BG, JB, CR, ST, FL, ND, KC, AS and BR. Their
    // tags are NOT unanimous (Tote Bag tagged "AS", Clutcher tagged "HA") or
    // the sample is a handful of products, so none is added. An invented tag
    // publishes successfully and drops the product out of its collection
    // silently (D23) — the worst failure this system has.
    const { data } = await serviceClient().from('categories').select('sku_prefix')
    expect((data as { sku_prefix: string }[]).map((c) => c.sku_prefix).sort()).toEqual([
      'AK', 'BK', 'CB', 'ER', 'HA', 'HC', 'INJ', 'NK', 'NP', 'RS', 'WH',
    ])
  })

  it('has a counter for every category, and none for anything else', async () => {
    const { data } = await serviceClient().from('sku_counters').select('sku_prefix, last_number')
    const { data: cats } = await serviceClient().from('categories').select('sku_prefix')
    const rows = data as { sku_prefix: string; last_number: number }[]

    expect(rows.map((r) => r.sku_prefix).sort()).toEqual(
      (cats as { sku_prefix: string }[]).map((c) => c.sku_prefix).sort(),
    )
    // Values are NOT asserted. Phase 2's `npm run seed:counters` sets them from
    // the true max per prefix, and `npm run verify:publish` legitimately burns
    // numbers. Pinning them to 0 would only assert that nobody has used the tool.
    expect(rows.every((r) => r.last_number >= 0)).toBe(true)
  })

  it('has the Phase 2 publish functions deployed', () => {
    for (const fn of [
      'raise_sku_counter',
      'reserve_draft_identity',
      'mark_draft_published',
      'mark_draft_failed',
    ]) {
      expect(report.functions, `${fn} is missing from the deployed schema`).toContain(fn)
    }
  })

  it('has exactly the three materials', async () => {
    const { data } = await serviceClient().from('materials').select('name').order('sort_order')
    expect((data as { name: string }[]).map((m) => m.name)).toEqual(['304', '316L', 'Brass'])
  })

  it('has an admin in app_users', async () => {
    const { data } = await serviceClient()
      .from('app_users')
      .select('email, role, active')
      .eq('role', 'admin')
    expect((data as unknown[]).length).toBeGreaterThan(0)
  })

  it('keeps NULL and 0 distinguishable on default_weight_g', async () => {
    // Qimati uses fixed shipping rates, so D19 settles every category default at
    // 0 g. The semantics that must survive that:
    //
    //   NULL → "nobody has said."   Publish is BLOCKED.
    //   0    → "someone said zero." Publish proceeds and writes 0 g.
    //
    // So the assertion is not "no zeros" any more — it is that the column can still
    // hold NULL, and that a NEGATIVE weight is still impossible. If a future
    // migration adds NOT NULL DEFAULT 0, the unknown state disappears and the guard
    // in src/lib/publish/validate.ts silently stops being reachable.
    const { data } = await serviceClient().from('categories').select('sku_prefix, default_weight_g')
    const rows = data as { sku_prefix: string; default_weight_g: number | null }[]

    expect(
      rows.filter((c) => (c.default_weight_g ?? 0) < 0),
      'a negative weight is nonsense and the CHECK should still reject it',
    ).toEqual([])
    expect(
      rows.filter((c) => c.default_weight_g !== 0),
      'fixed-rate shipping makes 0 g the settled default for every Qimati category',
    ).toEqual([])

    const column = report.columns['categories.default_weight_g']
    expect(column, 'categories.default_weight_g must still exist').toBeDefined()
  })

  it('still rejects a negative default_weight_g', async () => {
    const { error } = await serviceClient()
      .from('categories')
      .update({ default_weight_g: -1 })
      .eq('sku_prefix', 'NK')
    expect(error, 'the CHECK was relaxed from > 0 to >= 0, not dropped').not.toBeNull()
  })

  it('has exactly one verbatim default of each prompt kind', async () => {
    const { data, error } = await serviceClient()
      .from('prompts')
      .select('kind, body, is_default, archived_at')
      .eq('is_default', true)
      .is('archived_at', null)
      .order('kind')

    expect(error).toBeNull()
    const prompts = data as {
      kind: 'describe' | 'image'
      body: string
      is_default: boolean
      archived_at: string | null
    }[]

    expect(prompts.map((prompt) => prompt.kind)).toEqual(['describe', 'image'])
    expect(
      prompts.map((prompt) => ({
        kind: prompt.kind,
        chars: prompt.body.length,
        sha256: createHash('sha256').update(prompt.body).digest('hex'),
      })),
    ).toEqual([
      {
        kind: 'describe',
        chars: 1887,
        sha256: 'dc6b538b7dcecdcb445ac7d47a316be196b05d965fd7a75c9ff871ba5f545245',
      },
      {
        kind: 'image',
        chars: 3399,
        sha256: '01db8d7404d9fffb630859dcc014687759ed6178838b43f524df7e233b951cf0',
      },
    ])
    expect(prompts[0]?.body).toContain('Describe ONLY the jewellery in this photograph.')
    expect(prompts[0]?.body).toContain(
      'Return ONLY a JSON object, nothing else:',
    )
    expect(prompts[0]?.body).toContain(
      '"presentation": "<one class from the list>"',
    )
    expect(prompts[0]?.body).not.toContain('{{PRODUCT_DESCRIPTION}}')
    expect(prompts[1]?.body).toContain('PRODUCT\n{{PRODUCT_DESCRIPTION}}\n\nSUBJECT')
    expect(prompts[1]?.body).toContain('{{COMPOSITION_DETAIL}}')
    expect(prompts[1]?.body).not.toContain(
      'Preserve the angle and orientation of the piece as photographed',
    )
    expect(prompts[1]?.body).not.toMatch(/silver metal, rose gold/i)
    expect(prompts[1]?.body).not.toMatch(/2048|1536|1280|1024|aspect ratio/i)
  })

  it('can still store NULL — "nobody has said" has to remain expressible', async () => {
    // Round-trip on the tag-less NP category, which cannot publish anyway.
    const before = await serviceClient()
      .from('categories')
      .select('default_weight_g')
      .eq('sku_prefix', 'NP')
      .single()

    const { error } = await serviceClient()
      .from('categories')
      .update({ default_weight_g: null })
      .eq('sku_prefix', 'NP')
    expect(error, 'NOT NULL would erase the difference between unknown and zero').toBeNull()

    await serviceClient()
      .from('categories')
      .update({ default_weight_g: (before.data as { default_weight_g: number | null }).default_weight_g })
      .eq('sku_prefix', 'NP')
  })

  it('has pad_sku_number deployed, and it does not truncate above 999', async () => {
    expect(report.functions).toContain('pad_sku_number')
    const { data } = await serviceClient().rpc('pad_sku_number', { p_number: 1000 })
    expect(data, 'bare lpad(n, 3, ‘0’) returns "100" here, which is a SKU collision').toBe('1000')
  })
})
