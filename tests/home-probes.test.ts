import { describe, expect, it } from 'vitest'
import type { N8nClient } from '@/lib/home/n8n'
import { cached, memoryProbeStore, probeHttp, probeN8n, probeShopify, probeSupabase, runProbes, type ProbeOutcome } from '@/lib/home/probes'
import { probeDefs, STATIC_PROBES } from '@/lib/home/probes.config'

const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms: number) => { t += ms } } }
const fetchWith = (steps: Array<() => Response>, onCall?: () => void) => (async () => { onCall?.(); return (steps.shift() ?? (() => new Response('', { status: 200 })))() }) as unknown as typeof fetch

describe('http probe', () => {
  it('is green for a fast 2xx, amber over 2 s or on 4xx, red on 5xx, timeout or network error', async () => {
    const c = clock()
    expect((await probeHttp('https://a.example/', { fetchImpl: fetchWith([() => new Response('', { status: 200 })], () => c.tick(300)), now: c.now })).status).toBe('green')
    expect((await probeHttp('https://a.example/', { fetchImpl: fetchWith([() => new Response('', { status: 200 })], () => c.tick(2_500)), now: c.now })).status).toBe('amber')
    expect(await probeHttp('https://a.example/', { fetchImpl: fetchWith([() => new Response('', { status: 404 })]), now: c.now })).toMatchObject({ status: 'amber', detail: 'HTTP 404' })
    expect(await probeHttp('https://a.example/', { fetchImpl: fetchWith([() => new Response('', { status: 502 })]), now: c.now })).toMatchObject({ status: 'red', detail: 'HTTP 502' })
    expect(await probeHttp('https://a.example/', { fetchImpl: fetchWith([() => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }]), now: c.now })).toMatchObject({ status: 'red', detail: 'timed out' })
    expect(await probeHttp('https://a.example/', { fetchImpl: fetchWith([() => { throw new Error('ECONNREFUSED') }]), now: c.now })).toMatchObject({ status: 'red', detail: 'ECONNREFUSED' })
  })
  it('follows exactly one redirect', async () => {
    const c = clock(); let calls = 0
    const hop = () => new Response('', { status: 302, headers: { location: '/next' } })
    expect((await probeHttp('https://a.example/', { fetchImpl: fetchWith([hop, () => new Response('', { status: 200 })], () => { calls++ }), now: c.now })).status).toBe('green'); expect(calls).toBe(2)
    calls = 0
    expect((await probeHttp('https://a.example/', { fetchImpl: fetchWith([hop, hop, hop], () => { calls++ }), now: c.now })).status).toBe('green'); expect(calls).toBe(2)
  })
})
describe('n8n probe', () => {
  const client = (active: boolean, runs: { id: string; status: string; stoppedAt: string }[], fail = false): N8nClient => ({
    async workflow(id) { if (fail) throw new Error('n8n answered 503'); return { id, name: 'Main', active } },
    async executions() { return runs.map(run => ({ ...run, startedAt: run.stoppedAt })) },
  })
  const now = () => Date.parse('2026-09-23T10:00:00Z')
  it('green when active with no failure in 24 h, amber on a recent failure, red when inactive or unreachable', async () => {
    expect((await probeN8n('w', client(true, [{ id: '9', status: 'success', stoppedAt: '2026-09-23T09:00:00Z' }]), now)).status).toBe('green')
    expect((await probeN8n('w', client(true, []), now)).status).toBe('green')
    expect(await probeN8n('w', client(true, [{ id: '9', status: 'success', stoppedAt: '2026-09-23T09:00:00Z' }, { id: '8', status: 'error', stoppedAt: '2026-09-23T01:00:00Z' }]), now)).toMatchObject({ status: 'amber', detail: 'run 8 error' })
    expect((await probeN8n('w', client(true, [{ id: '8', status: 'error', stoppedAt: '2026-09-21T01:00:00Z' }]), now)).status).toBe('green')
    expect((await probeN8n('w', client(false, []), now)).status).toBe('red')
    expect(await probeN8n('w', client(true, [], true), now)).toMatchObject({ status: 'red', detail: 'n8n answered 503' })
  })
})
describe('supabase and shopify probes', () => {
  const db = (ms: number, c: ReturnType<typeof clock>, error: { message: string } | null = null) => ({ from: () => ({ select: () => Promise.resolve().then(() => { c.tick(ms); return { error } }) }) })
  it('grades supabase by latency and error', async () => {
    let c = clock(); expect((await probeSupabase(db(200, c), c.now)).status).toBe('green')
    c = clock(); expect((await probeSupabase(db(1_500, c), c.now)).status).toBe('amber')
    c = clock(); expect((await probeSupabase(db(3_500, c), c.now)).status).toBe('red')
    c = clock(); expect(await probeSupabase(db(10, c, { message: 'permission denied' }), c.now)).toMatchObject({ status: 'red', detail: 'permission denied' })
  })
  it('grades shopify by latency and throttle headroom', async () => {
    const shop = (ms: number, c: ReturnType<typeof clock>, throttle: { currentlyAvailable: number; maximumAvailable: number } | null, fail = false) => ({ lastThrottle: throttle, graphql: async <T>(): Promise<T> => { if (fail) throw new Error('401'); c.tick(ms); return {} as T } })
    let c = clock(); expect(await probeShopify(shop(300, c, { currentlyAvailable: 900, maximumAvailable: 1000 }), c.now)).toMatchObject({ status: 'green', detail: '300 ms · 90 % headroom' })
    c = clock(); expect((await probeShopify(shop(300, c, { currentlyAvailable: 100, maximumAvailable: 1000 }), c.now)).status).toBe('amber')
    c = clock(); expect((await probeShopify(shop(1_800, c, null), c.now)).status).toBe('amber')
    c = clock(); expect((await probeShopify(shop(10, c, null, true), c.now)).status).toBe('red')
  })
})
describe('running probes with state', () => {
  const defs = [{ key: 'a', label: 'A', kind: 'http' as const, target: 'https://a' }, { key: 'b', label: 'B', kind: 'http' as const, target: 'https://b' }]
  const outcome = (status: ProbeOutcome['status']): ProbeOutcome => ({ status, detail: status, ms: 1 })
  it('keeps `since` while a status holds, moves it on a change, and tells the store about changes only', async () => {
    const store = memoryProbeStore({ a: { status: 'green', since: '2026-09-22T00:00:00Z' } })
    const first = await runProbes(defs, async def => outcome(def.key === 'a' ? 'green' : 'red'), store, () => Date.parse('2026-09-23T03:12:00Z'))
    expect(first).toMatchObject([{ key: 'a', status: 'green', since: '2026-09-22T00:00:00Z' }, { key: 'b', status: 'red', since: '2026-09-23T03:12:00.000Z' }])
    expect(store.changes).toEqual([{ key: 'b', from: null, to: 'red' }])
    const second = await runProbes(defs, async def => outcome(def.key === 'a' ? 'amber' : 'red'), store, () => Date.parse('2026-09-23T04:00:00Z'))
    expect(second).toMatchObject([{ key: 'a', status: 'amber', since: '2026-09-23T04:00:00.000Z' }, { key: 'b', status: 'red', since: '2026-09-23T03:12:00.000Z' }])
    expect(store.changes).toHaveLength(2); expect(store.changes[1]).toEqual({ key: 'a', from: 'green', to: 'amber' })
  })
  it('a probe that throws becomes a red light; a store that throws never hides a light', async () => {
    const store = memoryProbeStore(); store.load = async () => { throw new Error('db down') }; store.changed = async () => { throw new Error('db down') }
    const lights = await runProbes(defs, async def => { if (def.key === 'a') throw new Error('boom'); return outcome('green') }, store, () => 0)
    expect(lights).toMatchObject([{ key: 'a', status: 'red', detail: 'boom' }, { key: 'b', status: 'green' }])
  })
  it('caches a value for the ttl and shares one refresh between concurrent callers', async () => {
    let refreshes = 0
    const get = cached(30_000, async () => ++refreshes)
    expect(await Promise.all([get(0), get(0)])).toEqual([1, 1]); expect(await get(29_999)).toBe(1); expect(await get(30_000)).toBe(2)
  })
  it('lists the static lights plus one per configured bot workflow, ids from env only', () => {
    expect(probeDefs({})).toEqual(STATIC_PROBES)
    expect(probeDefs({ HOME_N8N_WORKFLOWS: '{"Main bot":"abc","Order shipped":"d1"}' }).slice(-2)).toEqual([{ key: 'n8n-main-bot', label: 'Bot · Main bot', kind: 'n8n', target: 'abc' }, { key: 'n8n-order-shipped', label: 'Bot · Order shipped', kind: 'n8n', target: 'd1' }])
    expect(STATIC_PROBES.map(p => p.key)).toEqual(['loupe', 'packaging', 'linkedin', 'dtdc-portal', 'dtdc-api', 'supabase', 'shopify'])
  })
})
