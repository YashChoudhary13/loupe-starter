import { describe, expect, it } from 'vitest'
import { supabaseProbeStore } from '@/lib/home/probe-store'
import type { ProbeLight } from '@/lib/home/probes'

const light: ProbeLight = { key: 'shopify', label: 'Shopify', kind: 'shopify', status: 'red', detail: '401', ms: 9, since: '2026-09-23T03:12:00Z', checkedAt: '2026-09-23T03:12:00Z' }
function fakeDb(rows: Record<string, unknown>[] = [], failUpsert = false) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const db = { from: (table: string) => ({
    select: (...args: unknown[]) => { calls.push({ table, method: 'select', args }); return Promise.resolve({ data: rows, error: null }) },
    upsert: (...args: unknown[]) => { calls.push({ table, method: 'upsert', args }); return Promise.resolve({ error: failUpsert ? { message: 'boom' } : null }) },
    insert: (...args: unknown[]) => { calls.push({ table, method: 'insert', args }); return Promise.resolve({ error: null }) },
  }) }
  return { calls, db }
}
describe('probe state in Supabase', () => {
  it('loads the last change per key', async () => {
    const { db } = fakeDb([{ probe_key: 'loupe', status: 'green', since: '2026-09-22T00:00:00Z' }])
    expect(await supabaseProbeStore(db).load()).toEqual({ loupe: { status: 'green', since: '2026-09-22T00:00:00Z' } })
  })
  it('writes one upsert and one events row per change', async () => {
    const { db, calls } = fakeDb()
    await supabaseProbeStore(db).changed(light, 'green')
    expect(calls.map(call => `${call.table}.${call.method}`)).toEqual(['home_probe_state.upsert', 'events.insert'])
    expect(calls[0].args).toEqual([{ probe_key: 'shopify', status: 'red', detail: '401', since: '2026-09-23T03:12:00Z', checked_at: '2026-09-23T03:12:00Z' }, { onConflict: 'probe_key' }])
    expect(calls[1].args[0]).toMatchObject({ entity_type: 'home_probe', event: 'home.probe_changed', detail: { key: 'shopify', label: 'Shopify', from: 'green', to: 'red', reason: '401' }, actor: 'home' })
  })
  it('a failed upsert throws (runProbes ignores it) and writes no event', async () => {
    const { db, calls } = fakeDb([], true)
    await expect(supabaseProbeStore(db).changed(light, null)).rejects.toThrow('boom')
    expect(calls).toHaveLength(1)
  })
})
