# Qimati Platform — Implementation Plan, part 4 of 10 (health probes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here. Task 7 consumes Task 6 (part 3).

---

### Task 7: Health probes, their state table, the schema proof, the Shopify throttle reading

**Files:**
- Create: `src/lib/home/probes.config.ts`, `src/lib/home/probes.ts`, `supabase/migrations/20260923100000_home_probe_state.sql`, `scripts/verify-home-local-db.ts`
- Modify: `src/lib/shopify/client.ts` (add `lastThrottle`), `src/lib/tables.ts` (add `home_probe_state`)
- Test: `tests/home-probes.test.ts`; `tests/shopify-client.test.ts` (one added test)

**Interfaces:**
- Consumes: `N8nClient`, `workflowMap` (Task 6).
- Produces: `ProbeKind`, `ProbeDef`, `STATIC_PROBES`, `probeDefs(env?)` (config); `ProbeStatus`, `ProbeOutcome`, `ProbeLight`, `PROBE_TIMEOUT_MS`, `probeHttp(url, { fetchImpl, now })`, `probeN8n(workflowId, client, now)`, `ProbeDb`, `probeSupabase(db, now)`, `ShopifyProbeClient`, `SHOP_PROBE_QUERY`, `probeShopify(client, now)`, `ProbeState`, `ProbeStateStore`, `memoryProbeStore(initial?)`, `runProbes(defs, run, store, now)`, `cached(ttlMs, refresh)`; `ShopifyClient.lastThrottle`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/home-probes.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { N8nClient } from '@/lib/home/n8n'
import { cached, memoryProbeStore, PROBE_TIMEOUT_MS, probeHttp, probeN8n, probeShopify, probeSupabase, runProbes, type ProbeOutcome } from '@/lib/home/probes'
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
  it('shares one 5 s abort signal across the redirect and its target', async () => {
    const c = clock()
    const seen: RequestInit[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => { seen.push(init); return seen.length === 1 ? new Response('', { status: 302, headers: { location: '/next' } }) : new Response('', { status: 200 }) }) as unknown as typeof fetch
    await probeHttp('https://a.example/', { fetchImpl, now: c.now })
    expect(seen).toHaveLength(2)
    expect(seen[0].signal).toBe(seen[1].signal)
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
  it('an unknown previous state (a failed load) is never treated as a change', async () => {
    const store = memoryProbeStore(); store.load = async () => { throw new Error('db down') }
    const lights = await runProbes(defs, async def => outcome(def.key === 'a' ? 'green' : 'red'), store, () => Date.parse('2026-09-23T03:12:00Z'))
    expect(lights).toMatchObject([{ key: 'a', status: 'green', since: '2026-09-23T03:12:00.000Z' }, { key: 'b', status: 'red', since: '2026-09-23T03:12:00.000Z' }])
    expect(store.changes).toEqual([])
  })
  it('bounds a hung load so probes still resolve within the timeout', async () => {
    vi.useFakeTimers()
    try {
      const store = memoryProbeStore(); store.load = () => new Promise(() => {})
      const pending = runProbes(defs, async def => outcome(def.key === 'a' ? 'green' : 'red'), store, () => Date.parse('2026-09-23T03:12:00Z'))
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1)
      const lights = await pending
      expect(lights).toMatchObject([{ key: 'a', status: 'green', since: '2026-09-23T03:12:00.000Z' }, { key: 'b', status: 'red', since: '2026-09-23T03:12:00.000Z' }])
    } finally { vi.useRealTimers() }
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
```

Append to `tests/shopify-client.test.ts`, inside the `describe('ShopifyClient', …)` block, as its last test:
```ts
  it('remembers the throttle status of the last response for the Home probe', async () => {
    const h = harness([() => json({ data: { shop: { name: 'Qimati' } }, extensions: { cost: { throttleStatus: { currentlyAvailable: 800, maximumAvailable: 1000, restoreRate: 50 } } } })])
    expect(h.client.lastThrottle).toBeNull()
    await h.client.graphql('{ shop { name } }')
    expect(h.client.lastThrottle).toEqual({ currentlyAvailable: 800, maximumAvailable: 1000 })
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/home-probes.test.ts tests/shopify-client.test.ts`
Expected: FAIL — modules missing; `lastThrottle` undefined.
- [ ] **Step 3: The probe table and the probe functions**

```ts
// src/lib/home/probes.config.ts
import { workflowMap } from './n8n'

export type ProbeKind = 'http' | 'n8n' | 'supabase' | 'shopify'
/** `target`: the URL for `http`, the workflow id for `n8n`, unused otherwise. Adding a light is one entry here. */
export interface ProbeDef { key: string; label: string; kind: ProbeKind; target: string }

/** DTDC has no API and its connector cannot be observed from here, so those two lights say "reachable" and mean only that. */
export const STATIC_PROBES: readonly ProbeDef[] = [
  { key: 'loupe', label: 'Loupe', kind: 'http', target: 'https://loupe.qimati-eng.site/health' },
  { key: 'packaging', label: 'Packaging', kind: 'http', target: 'https://packaging.qimati-eng.site/' },
  { key: 'linkedin', label: 'LinkedIn', kind: 'http', target: 'https://linkedin.qimati-eng.site/' },
  { key: 'dtdc-portal', label: 'DTDC portal reachable', kind: 'http', target: 'https://customer.dtdc.in/' },
  { key: 'dtdc-api', label: 'DTDC connector reachable', kind: 'http', target: 'https://pxapi.dtdc.in/' },
  { key: 'supabase', label: 'Supabase', kind: 'supabase', target: '' },
  { key: 'shopify', label: 'Shopify', kind: 'shopify', target: '' },
]
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)

/** The static lights plus one `n8n` light per workflow in HOME_N8N_WORKFLOWS (ids come from env, never from source). */
export function probeDefs(env: Record<string, string | undefined> = process.env): ProbeDef[] {
  const bots = Object.entries(workflowMap(env.HOME_N8N_WORKFLOWS)).map(([label, id]) => ({ key: `n8n-${slug(label)}`, label: `Bot · ${label}`, kind: 'n8n' as const, target: id }))
  return [...STATIC_PROBES, ...bots]
}
```

```ts
// src/lib/home/probes.ts
import type { N8nClient } from './n8n'
import type { ProbeDef, ProbeKind } from './probes.config'

export type ProbeStatus = 'green' | 'amber' | 'red'
export interface ProbeOutcome { status: ProbeStatus; detail: string; ms: number }
export interface ProbeLight extends ProbeOutcome { key: string; label: string; kind: ProbeKind; since: string; checkedAt: string }
export const PROBE_TIMEOUT_MS = 5_000
const red = (detail: string, ms: number): ProbeOutcome => ({ status: 'red', detail, ms })
const reason = (error: unknown): string => error instanceof Error ? (error.name === 'TimeoutError' ? 'timed out' : error.message) : String(error)
const getInit = (signal: AbortSignal): RequestInit => ({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'Qimati-home-probe' }, signal })

/** GET, one redirect followed by hand, one 5 s signal shared by both hops. 2xx–3xx under 2 s green; slower or 4xx amber; 5xx, timeout or a network error red. */
export async function probeHttp(url: string, deps: { fetchImpl: typeof fetch; now: () => number }): Promise<ProbeOutcome> {
  const started = deps.now()
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  try {
    let response = await deps.fetchImpl(url, getInit(signal))
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) response = await deps.fetchImpl(new URL(location, url).toString(), getInit(signal))
    const ms = deps.now() - started
    if (response.status >= 500) return red(`HTTP ${response.status}`, ms)
    if (response.status >= 400) return { status: 'amber', detail: `HTTP ${response.status}`, ms }
    return { status: ms < 2_000 ? 'green' : 'amber', detail: `HTTP ${response.status} in ${ms} ms`, ms }
  } catch (error) { return red(reason(error), deps.now() - started) }
}

/** Active with no failed run in the last 24 h green; active with a failure in 24 h amber; inactive or unreachable red. */
export async function probeN8n(workflowId: string, client: N8nClient, now: () => number): Promise<ProbeOutcome> {
  const started = now()
  try {
    const [workflow, runs] = await Promise.all([client.workflow(workflowId), client.executions(workflowId, 5)])
    const ms = now() - started
    if (!workflow.active) return red(`${workflow.name}: inactive`, ms)
    const dayAgo = now() - 86_400_000
    const failed = runs.find(run => ['error', 'crashed'].includes(run.status) && Date.parse(run.stoppedAt ?? run.startedAt ?? '') >= dayAgo)
    if (failed) return { status: 'amber', detail: `run ${failed.id} ${failed.status}`, ms }
    return { status: 'green', detail: runs[0] ? `last run ${runs[0].status}` : 'active, no recent runs', ms }
  } catch (error) { return red(reason(error), now() - started) }
}

export interface ProbeDb { from(table: string): { select(columns: string, options: { count: 'exact'; head: true }): PromiseLike<{ error: { message: string } | null }> } }
/** One trivial read through the service client. Under 1 s green, under 3 s amber, else red. */
export async function probeSupabase(db: ProbeDb, now: () => number): Promise<ProbeOutcome> {
  const started = now()
  try {
    const result = await withTimeout(db.from('app_users').select('id', { count: 'exact', head: true }), PROBE_TIMEOUT_MS)
    const ms = now() - started
    if (result.error) return red(result.error.message, ms)
    return { status: ms < 1_000 ? 'green' : ms < 3_000 ? 'amber' : 'red', detail: `${ms} ms`, ms }
  } catch (error) { return red(reason(error), now() - started) }
}

export interface ShopifyProbeClient { graphql<T>(query: string): Promise<T>; readonly lastThrottle: { currentlyAvailable: number; maximumAvailable: number } | null }
export const SHOP_PROBE_QUERY = 'query LoupeHomeShop { shop { name } }'
/** `shop { name }`, timed; headroom from the cost extension of that response (GraphQL carries it in the body, not in headers). Under 1.5 s with more than 20 % headroom green; slower or tighter amber; error red. */
export async function probeShopify(client: ShopifyProbeClient, now: () => number): Promise<ProbeOutcome> {
  const started = now()
  try {
    await withTimeout(client.graphql<{ shop: { name: string } }>(SHOP_PROBE_QUERY), PROBE_TIMEOUT_MS)
    const ms = now() - started
    const throttle = client.lastThrottle
    const headroom = throttle && throttle.maximumAvailable > 0 ? throttle.currentlyAvailable / throttle.maximumAvailable : 1
    return { status: ms < 1_500 && headroom > 0.2 ? 'green' : 'amber', detail: `${ms} ms · ${Math.round(headroom * 100)} % headroom`, ms }
  } catch (error) { return red(reason(error), now() - started) }
}

export function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms)
    Promise.resolve(work).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

export interface ProbeState { status: ProbeStatus; since: string }
export interface ProbeStateStore { load(): Promise<Record<string, ProbeState>>; changed(light: ProbeLight, previous: ProbeStatus | null): Promise<void> }
export function memoryProbeStore(initial: Record<string, ProbeState> = {}): ProbeStateStore & { changes: { key: string; from: ProbeStatus | null; to: ProbeStatus }[] } {
  const state = { ...initial }
  const store = {
    changes: [] as { key: string; from: ProbeStatus | null; to: ProbeStatus }[],
    async load() { return { ...state } },
    async changed(light: ProbeLight, previous: ProbeStatus | null) { state[light.key] = { status: light.status, since: light.since }; store.changes.push({ key: light.key, from: previous, to: light.status }) },
  }
  return store
}

/** Every probe in parallel. A light's `since` moves only when its status changes, only a change reaches the store, and a store failure or hang never hides a light. A `load` that fails or takes longer than 5 s leaves the previous state unknown, so nothing counts as a change that round; the resulting `changed` writes are themselves bounded and run in parallel. */
export async function runProbes(defs: readonly ProbeDef[], run: (def: ProbeDef) => Promise<ProbeOutcome>, store: ProbeStateStore, now: () => number): Promise<ProbeLight[]> {
  const previous = await withTimeout(store.load(), PROBE_TIMEOUT_MS).catch((): Record<string, ProbeState> | null => null)
  const checkedAt = new Date(now()).toISOString()
  const outcomes = await Promise.all(defs.map(def => run(def).catch((error: unknown) => red(reason(error), 0))))
  const lights: ProbeLight[] = []
  const pairs: [ProbeLight, ProbeStatus | null][] = []
  for (const [index, def] of defs.entries()) {
    const outcome = outcomes[index], before = previous?.[def.key]
    const light: ProbeLight = { key: def.key, label: def.label, kind: def.kind, ...outcome, since: before && before.status === outcome.status ? before.since : checkedAt, checkedAt }
    if (previous && (!before || before.status !== outcome.status)) pairs.push([light, before?.status ?? null])
    lights.push(light)
  }
  await Promise.all(pairs.map(([light, before]) => withTimeout(store.changed(light, before), PROBE_TIMEOUT_MS).catch(() => undefined)))
  return lights
}

/** One value per process, refreshed at most every `ttlMs`; concurrent callers share one refresh; a failed refresh returns the previous value when there is one. */
export function cached<T>(ttlMs: number, refresh: () => Promise<T>): (now: number) => Promise<T> {
  let value: { at: number; data: T } | null = null, inFlight: Promise<T> | null = null
  return async (now) => {
    if (value && now - value.at < ttlMs) return value.data
    inFlight ??= refresh().then(data => { value = { at: now, data }; return data }).catch((error: unknown) => { if (value) return value.data; throw error }).finally(() => { inFlight = null })
    return inFlight
  }
}
```

- [ ] **Step 4: The throttle reading in `ShopifyClient`** — in `src/lib/shopify/client.ts`: change the envelope's `extensions` to `extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; maximumAvailable?: number } } }`; add to the class, after `private requestCount = 0`:
```ts
  /** Throttle status from the cost extension of the last successful response — the Home probe's headroom reading. */
  lastThrottle: { currentlyAvailable: number; maximumAvailable: number } | null = null
```
and in `attempt`, just before `return envelope.data`:
```ts
    const throttle = envelope.extensions?.cost?.throttleStatus
    if (typeof throttle?.currentlyAvailable === 'number' && typeof throttle.maximumAvailable === 'number') this.lastThrottle = { currentlyAvailable: throttle.currentlyAvailable, maximumAvailable: throttle.maximumAvailable }
```

- [ ] **Step 5: The table, `TABLES`, and the schema proof**
```sql
-- supabase/migrations/20260923100000_home_probe_state.sql
-- Home dashboard (D137): the last known state of each health probe, so a light can say "red since 03:12".
-- Only a CHANGE is written; every change also writes an events row (home.probe_changed).
create table public.home_probe_state (
  probe_key text primary key check (probe_key ~ '^[a-z0-9_-]{1,40}$'),
  status text not null check (status in ('green','amber','red')),
  detail text not null default '',
  since timestamptz not null default now(),
  checked_at timestamptz not null default now()
);
alter table public.home_probe_state enable row level security;
revoke all on public.home_probe_state from public, anon, authenticated;
grant select, insert, update, delete on public.home_probe_state to service_role;
comment on table public.home_probe_state is 'One row per Home health probe: current status and when it last changed. Written only by the server on a change.';
```
In `src/lib/tables.ts` add `'home_probe_state',` after `'restock_decisions',`.
```ts
// scripts/verify-home-local-db.ts
/** Isolated proof of the home_probe_state schema. Temporary local PostgreSQL only; no .env, no network. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

async function main() {
  const bin = process.env.LOUPE_TEST_PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'
  const root = mkdtempSync(join(tmpdir(), 'loupe-home-'))
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'loupe_test', '-A', 'trust', '--no-locale'], { stdio: 'pipe' })
  const child = spawn(join(bin, 'postgres'), ['-D', join(root, 'data'), '-h', '', '-k', root, '-p', '55441'], { stdio: 'ignore' })
  const pool = new Pool({ host: root, port: 55441, user: 'loupe_test', database: 'postgres' })
  const checks: string[] = []
  const refuses = async (name: string, sql: string) => { await assert.rejects(pool.query(sql), name); checks.push(name) }
  try {
    for (let attempt = 0; ; attempt++) { try { await pool.query('select 1'); break } catch (error) { if (attempt > 49) throw error; await new Promise(r => setTimeout(r, 100)) } }
    await pool.query('create role anon; create role authenticated; create role service_role bypassrls;')
    await pool.query('alter default privileges in schema public grant all on tables to anon, authenticated, service_role;')
    await pool.query(readFileSync('supabase/migrations/20260923100000_home_probe_state.sql', 'utf8'))
    await pool.query("insert into public.home_probe_state(probe_key,status,detail) values('shopify','green','300 ms')")
    await refuses('a probe has one row', "insert into public.home_probe_state(probe_key,status) values('shopify','red')")
    await refuses('status is green, amber or red', "insert into public.home_probe_state(probe_key,status) values('loupe','blue')")
    await refuses('a key is a short slug', "insert into public.home_probe_state(probe_key,status) values('not a key!','red')")
    await pool.query("insert into public.home_probe_state(probe_key,status,detail,since,checked_at) values('shopify','red','HTTP 502',now(),now()) on conflict (probe_key) do update set status=excluded.status, detail=excluded.detail, since=excluded.since, checked_at=excluded.checked_at")
    assert.equal((await pool.query("select status from public.home_probe_state where probe_key='shopify'")).rows[0].status, 'red'); checks.push('upsert by key replaces the state')
    assert.equal((await pool.query("select relrowsecurity from pg_class where oid='public.home_probe_state'::regclass")).rows[0].relrowsecurity, true); checks.push('row level security is on')
    assert.equal((await pool.query("select count(*)::int as n from pg_policy where polrelid='public.home_probe_state'::regclass")).rows[0].n, 0); checks.push('zero policies')
    for (const role of ['anon', 'authenticated']) {
      const conn = await pool.connect()
      try { await conn.query(`set role ${role}`); await assert.rejects(conn.query('select 1 from public.home_probe_state')); checks.push(`${role} cannot read`) } finally { await conn.query('reset role'); conn.release() }
    }
    const admin = await pool.connect()
    try {
      await admin.query('set role service_role')
      await admin.query("insert into public.home_probe_state(probe_key,status,detail) values('linkedin','green','ok')")
      assert.equal((await admin.query("select status from public.home_probe_state where probe_key='linkedin'")).rows[0].status, 'green')
      checks.push('service_role can read and write')
    } finally { await admin.query('reset role'); admin.release() }
    console.log(`home schema proof: ${checks.length} checks passed\n- ${checks.join('\n- ')}`)
  } finally { await pool.end(); child.kill('SIGINT') }
}
main().catch(error => { console.error(error); process.exit(1) })
```

- [ ] **Step 6: Run the tests, the proof, typecheck, lint**

Run: `npx vitest run tests/home-probes.test.ts tests/shopify-client.test.ts && npx tsx scripts/verify-home-local-db.ts && npm run typecheck && npx eslint src/lib/home/probes.ts src/lib/home/probes.config.ts src/lib/shopify/client.ts src/lib/tables.ts scripts/verify-home-local-db.ts tests/home-probes.test.ts`
Expected: both test files PASS; `home schema proof: 9 checks passed`; typecheck and lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/home/probes.config.ts src/lib/home/probes.ts supabase/migrations/20260923100000_home_probe_state.sql scripts/verify-home-local-db.ts src/lib/shopify/client.ts src/lib/tables.ts tests/home-probes.test.ts tests/shopify-client.test.ts
git commit -m "feat(home): health probes — http, n8n, Supabase, Shopify with injected clock and fetch; state table records only changes"
```
