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

function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
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
