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

describe('next_sku is not callable without the service role', () => {
  // Burning SKU numbers from the browser would open gaps in the sequence for
  // free. EXECUTE is revoked from PUBLIC, anon and authenticated.
  it('refuses an anonymous RPC call', async () => {
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/next_sku`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_prefix: 'NK' }),
    })

    expect(res.ok, `anonymous next_sku call returned HTTP ${res.status}`).toBe(false)
    expect([401, 403, 404]).toContain(res.status)
  })
})
