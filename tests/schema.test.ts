/**
 * Schema invariants.
 *
 * These assert against the DEPLOYED database, not the migration files. The two
 * drift the moment somebody edits something in the Supabase SQL editor, and the
 * things that drift most quietly — a dropped index, an RLS flag turned off to
 * debug something at 1am — are exactly the ones nothing else notices.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { TABLES } from '../src/lib/tables'
import { serviceClient } from './helpers/db'

interface SchemaReport {
  tables: { name: string; rls_enabled: boolean; policy_count: number }[]
  indexes: string[]
  enums: Record<string, string[]>
  functions: string[]
  columns: Record<string, string>
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
    'intake_files_phash_idx',
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

  it('the broken control fixture is not left loaded in the database', () => {
    expect(
      report.functions,
      '_loupe_naive_next_sku is a deliberately broken counter — it must never be present outside a control run',
    ).not.toContain('_loupe_naive_next_sku')
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
    // Nose Pins (Phase 2) is the odd one out: its prefix and title pattern are
    // confirmed, its TAG IS NOT, so the tag is NULL and publish refuses the
    // category rather than inventing one.
    expect(data).toEqual([
      { name: 'Necklaces', sku_prefix: 'NK', title_pattern: 'Necklace {n}', shopify_tag: 'Necklace' },
      { name: 'Earrings', sku_prefix: 'ER', title_pattern: 'Earrings {n}', shopify_tag: 'earrings' },
      { name: 'Kada Bracelets', sku_prefix: 'BK', title_pattern: 'Bracelet Kada {n}', shopify_tag: 'kada' },
      { name: 'Chain Bracelets', sku_prefix: 'CB', title_pattern: 'Chain Bracelet {n}', shopify_tag: 'cb' },
      { name: 'Rings', sku_prefix: 'RS', title_pattern: 'Rings {n}', shopify_tag: 'Rings' },
      { name: 'Anklets', sku_prefix: 'AK', title_pattern: 'Anklets {n} (Single Piece)', shopify_tag: 'anklets' },
      { name: 'Nose Pins', sku_prefix: 'NP', title_pattern: 'Nose Pin {n}', shopify_tag: null },
    ])
  })

  it('invents no prefix for the seven still-TBD categories', async () => {
    // Watches, Hand Chains, Jewellery Box, Bags, Hair Accessories, Indian
    // Jewellery and Brass have no confirmed prefix. An invented one starts a
    // sequence that has to be unpicked later.
    const { data } = await serviceClient().from('categories').select('sku_prefix')
    expect((data as { sku_prefix: string }[]).map((c) => c.sku_prefix).sort()).toEqual([
      'AK', 'BK', 'CB', 'ER', 'NK', 'NP', 'RS',
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

  it('leaves default_weight_g NULL rather than 0, so publish cannot inherit the live bug', async () => {
    const { data } = await serviceClient().from('categories').select('sku_prefix, default_weight_g')
    const zeroed = (data as { sku_prefix: string; default_weight_g: number | null }[]).filter(
      (c) => c.default_weight_g === 0,
    )
    expect(zeroed, 'every live variant has weight 0 and weight-based shipping is broken because of it').toEqual([])
  })
})
