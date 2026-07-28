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
})

describe('the SKU and publish functions are not callable without the service role', () => {
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
  ]

  for (const [fn, body] of phase2Functions) {
    it(`refuses an anonymous ${fn} call`, async () => {
      const res = await anonymousRpc(fn, body)
      expect(res.ok, `anonymous ${fn} call returned HTTP ${res.status}`).toBe(false)
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
