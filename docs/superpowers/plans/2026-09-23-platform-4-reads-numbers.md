# Qimati Platform — Implementation Plan, part 4 of 8 (read-only Shopify, numbers, server wiring)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here. Task 8 consumes Tasks 6–7 (part 3).

---

### Task 8: Read-only Shopify, the numbers, and the server wiring with caches

**Files:**
- Create: `src/lib/home/shopify-reads.ts`, `src/lib/home/numbers.ts`, `src/lib/home/probe-store.ts`, `src/lib/home/server.ts`
- Test: `tests/home-shopify-reads.test.ts`, `tests/home-numbers.test.ts`, `tests/home-probe-store.test.ts`

**Interfaces:**
- Consumes: `PAID` (`src/lib/shopify/qc-orders.ts`), `qcOrderStatuses`, `listParcels`, `listShortages`, `supabaseServer`, `ShopifyClient`, Task 6–7 exports.
- Produces: `ReadOnlyShopify`, `readOnlyShopify(client)`, `OPEN_PAID_QUERY`, `ORDER_FILTERS`, `OrderFilter`, `istDayStart(now)`, `orderQuery(filter, now)`, `ORDERS_QUERY`, `ORDER_IDS_QUERY`, `COUNT_QUERY`, `LOW_STOCK_QUERY`, `OrderRow`, `listOrders(shop, query, limit)`, `listOrderIds(shop, query, max?)`, `countOrders(shop, query)`, `StockRow`, `lowStock(shop, threshold, limit)` (reads); `HomeNumbers`, `NumberDeps`, `computeNumbers(deps)` (numbers); `ProbeStoreDb`, `supabaseProbeStore(db)` (probe-store); `homeShopify()`, `homeReadOnlyShopify()`, `qcPassed(ids)`, `HomeSnapshot`, `homeSnapshot()` (server, cached 30 s lights / 60 s numbers).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/home-shopify-reads.test.ts
import { describe, expect, it } from 'vitest'
import { COUNT_QUERY, countOrders, istDayStart, listOrderIds, listOrders, LOW_STOCK_QUERY, lowStock, ORDER_IDS_QUERY, orderQuery, ORDERS_QUERY, readOnlyShopify, type ReadOnlyShopify } from '@/lib/home/shopify-reads'

const record = () => { const calls: { query: string; variables?: Record<string, unknown> }[] = []; const client = { async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> { calls.push({ query, variables }); return {} as T } }; return { calls, client } }
describe('read-only Shopify', () => {
  it('refuses any document containing a mutation before it is sent', async () => {
    const { calls, client } = record(); const shop = readOnlyShopify(client)
    for (const doc of ['mutation { x }', 'query Q { a } mutation M { b }', ' MUTATION x', 'query { shop { name } } # mutation']) await expect(shop.graphql(doc)).rejects.toThrow(/read-only/)
    expect(calls).toHaveLength(0)
    await shop.graphql('query { shop { name } }'); expect(calls).toHaveLength(1)
  })
  it('every constant query asks for no customer, email, phone or address field', () => {
    for (const query of [ORDERS_QUERY, ORDER_IDS_QUERY, COUNT_QUERY, LOW_STOCK_QUERY]) expect(query).not.toMatch(/customer|email|phone|address|billing/i)
  })
  it('builds the documented search per filter, with today in IST', () => {
    expect(istDayStart(new Date('2026-09-23T20:30:00Z'))).toBe('2026-09-24T00:00:00+05:30'); expect(istDayStart(new Date('2026-09-23T17:00:00Z'))).toBe('2026-09-23T00:00:00+05:30')
    expect(orderQuery('unfulfilled', new Date())).toBe('status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) (financial_status:paid OR financial_status:partially_paid OR financial_status:partially_refunded)')
    expect(orderQuery('awaiting_qc', new Date())).toBe(orderQuery('unfulfilled', new Date()))
    expect(orderQuery('today', new Date('2026-09-23T17:00:00Z'))).toBe("created_at:>='2026-09-23T00:00:00+05:30' -status:cancelled")
    expect(orderQuery('on_hold', new Date())).toBe('status:open fulfillment_status:on_hold')
  })
  it('a raw client is not assignable as read-only (compile-time)', () => {
    // @ts-expect-error a raw client is not read-only
    const notReadOnly: ReadOnlyShopify = { async graphql() { return {} } }
    void notReadOnly
  })
})
describe('readers', () => {
  it('maps orders to the six safe fields', async () => {
    const shop: ReadOnlyShopify = { readOnly: true, async graphql<T>() { return { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: 'Qimati1', createdAt: '2026-09-23T05:00:00Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', subtotalLineItemsQuantity: 3, totalPriceSet: { shopMoney: { amount: '1200.00', currencyCode: 'INR' } } }] } } as T } }
    expect(await listOrders(shop, 'q', 5)).toEqual({ ids: ['gid://shopify/Order/1'], rows: [{ name: 'Qimati1', createdAt: '2026-09-23T05:00:00Z', payment: 'PAID', fulfilment: 'UNFULFILLED', total: '1200.00 INR', items: 3 }] })
  })
  it('pages ids up to the cap and says when it stopped early', async () => {
    let page = 0
    const afters: unknown[] = []
    const shop: ReadOnlyShopify = { readOnly: true, async graphql<T>(_query: string, variables?: Record<string, unknown>) { afters.push(variables?.after); page++; return { orders: { nodes: Array.from({ length: 100 }, (_, n) => ({ id: `gid://shopify/Order/${page * 100 + n}` })), pageInfo: { hasNextPage: true, endCursor: `c${page}` } } } as T } }
    const result = await listOrderIds(shop, 'q', 250)
    expect(result.ids).toHaveLength(250); expect(result.truncated).toBe(true); expect(page).toBe(3)
    expect(afters).toEqual([null, 'c1', 'c2'])
  })
  it('counts through ordersCount and reads low stock with the threshold in the search', async () => {
    const { calls, client } = record()
    client.graphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => { calls.push({ query, variables }); return (query === COUNT_QUERY ? { ordersCount: { count: 7, precision: 'EXACT' } } : { productVariants: { nodes: [{ sku: 'RS004-C-GOLD', title: 'Gold', inventoryQuantity: 1, product: { title: 'Rings 004' } }] } }) as T }
    const shop = readOnlyShopify(client)
    expect(await countOrders(shop, 'status:open')).toBe(7)
    expect(await lowStock(shop, 3, 10)).toEqual([{ sku: 'RS004-C-GOLD', product: 'Rings 004', variant: 'Gold', quantity: 1 }])
    expect(calls[1].variables).toEqual({ query: 'inventory_quantity:<=3 product_status:active', first: 10 })
  })
})
```

```ts
// tests/home-numbers.test.ts
import { describe, expect, it, vi } from 'vitest'
import { computeNumbers, NUMBERS_TIMEOUT_MS } from '@/lib/home/numbers'
import { COUNT_QUERY, ORDER_IDS_QUERY, OPEN_PAID_QUERY, orderQuery, type ReadOnlyShopify } from '@/lib/home/shopify-reads'

const shop = (counts: Record<string, number>, ids: string[]): ReadOnlyShopify => ({ readOnly: true, async graphql<T>(query: string, variables?: Record<string, unknown>) {
  if (query === COUNT_QUERY) return { ordersCount: { count: counts[String(variables?.query)] ?? 0, precision: 'EXACT' } } as T
  if (query === ORDER_IDS_QUERY) return { orders: { nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } } } as T
  throw new Error(`unexpected query ${query}`)
} })
const now = () => new Date('2026-09-23T20:30:00Z') // 02:00 IST on the 24th

describe('home numbers', () => {
  it('counts today in IST, paid unfulfilled, awaiting QC (open minus passed), open parcels and open shortages', async () => {
    const client = shop({ [orderQuery('today', now())]: 4, [OPEN_PAID_QUERY]: 12 }, ['gid://shopify/Order/1', 'gid://shopify/Order/2', 'gid://shopify/Order/3'])
    const numbers = await computeNumbers({ shop: client, qcPassed: async ids => ({ [ids[0]]: true }), openParcels: async () => 5, openShortages: async () => 2, now })
    expect(numbers).toMatchObject({ ordersToday: 4, paidUnfulfilled: 12, awaitingQc: 2, awaitingQcCapped: false, awaitingTracking: 5, openShortages: 2, problems: [], computedAt: '2026-09-23T20:30:00.000Z' })
  })
  it('a failed check is a null with its reason, never a thrown page', async () => {
    const client: ReadOnlyShopify = { readOnly: true, async graphql() { throw new Error('Shopify 502') } }
    const numbers = await computeNumbers({ shop: client, qcPassed: async () => ({}), openParcels: async () => { throw new Error('db down') }, openShortages: async () => 0, now })
    expect(numbers).toMatchObject({ ordersToday: null, paidUnfulfilled: null, awaitingQc: null, awaitingTracking: null, openShortages: 0 })
    expect(numbers.problems).toEqual(expect.arrayContaining([expect.stringContaining('Shopify 502'), expect.stringContaining('db down')]))
  })
  it('without Shopify configured the Shopify numbers are null and it says so', async () => {
    const numbers = await computeNumbers({ shop: null, qcPassed: async () => ({}), openParcels: async () => 0, openShortages: async () => 0, now })
    expect(numbers.ordersToday).toBeNull(); expect(numbers.problems).toContain('Shopify is not configured.')
  })
  it('a stalled Shopify read times out instead of hanging the page', async () => {
    vi.useFakeTimers()
    try {
      const client: ReadOnlyShopify = { readOnly: true, async graphql() { return new Promise(() => {}) } }
      const pending = computeNumbers({ shop: client, qcPassed: async () => ({}), openParcels: async () => 5, openShortages: async () => 2, now })
      await vi.advanceTimersByTimeAsync(NUMBERS_TIMEOUT_MS + 1)
      const numbers = await pending
      expect(numbers).toMatchObject({ ordersToday: null, awaitingTracking: 5, openShortages: 2 })
      expect(numbers.problems).toContain('orders today: timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})
```

```ts
// tests/home-probe-store.test.ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/home-shopify-reads.test.ts tests/home-numbers.test.ts tests/home-probe-store.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: The reads**

```ts
// src/lib/home/shopify-reads.ts
import type { ShopifyClient } from '@/lib/shopify/client'
import { PAID } from '@/lib/shopify/qc-orders'

/** `readOnly` brands this type so a raw `ShopifyClient` (structurally just `{ graphql }`) cannot stand in for it by accident — only `readOnlyShopify()` below can produce one. */
export interface ReadOnlyShopify { readonly readOnly: true; graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> }
/** The assistant's only route to Shopify (D137). A document containing a mutation is refused before it is sent, and every query it carries is a constant in this file. */
export function readOnlyShopify(client: Pick<ShopifyClient, 'graphql'>): ReadOnlyShopify {
  return { readOnly: true, graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (/\bmutation\b/i.test(query)) return Promise.reject(new Error('The home assistant is read-only: mutations are refused.'))
    return client.graphql<T>(query, variables)
  } }
}

export const OPEN_PAID_QUERY = `status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) ${PAID}`
export const ORDER_FILTERS = ['unfulfilled', 'awaiting_qc', 'awaiting_tracking', 'today', 'on_hold'] as const
export type OrderFilter = (typeof ORDER_FILTERS)[number]
/** Midnight in Asia/Kolkata for the calendar day containing `now`, with the +05:30 offset Shopify's search accepts. */
export function istDayStart(now: Date): string { return `${new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00+05:30` }
export function orderQuery(filter: Exclude<OrderFilter, 'awaiting_tracking'>, now: Date): string {
  if (filter === 'today') return `created_at:>='${istDayStart(now)}' -status:cancelled`
  if (filter === 'on_hold') return 'status:open fulfillment_status:on_hold'
  return OPEN_PAID_QUERY
}

/* No customer, email, phone or address field in any of these — by construction, and asserted by tests/home-shopify-reads.test.ts. */
export const ORDERS_QUERY = `query LoupeHomeOrders($query: String!, $first: Int!) { orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus subtotalLineItemsQuantity totalPriceSet { shopMoney { amount currencyCode } } } } }`
export const ORDER_IDS_QUERY = `query LoupeHomeOrderIds($query: String!, $after: String) { orders(first: 100, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { id } pageInfo { hasNextPage endCursor } } }`
export const COUNT_QUERY = `query LoupeHomeCount($query: String!) { ordersCount(query: $query, limit: 10000) { count precision } }`
export const LOW_STOCK_QUERY = `query LoupeHomeLowStock($query: String!, $first: Int!) { productVariants(first: $first, query: $query, sortKey: INVENTORY_QUANTITY) { nodes { sku title inventoryQuantity product { title } } } }`

export interface OrderRow { name: string; createdAt: string; payment: string; fulfilment: string; total: string; items: number }
interface RawOrder { id: string; name: string; createdAt: string; displayFinancialStatus: string; displayFulfillmentStatus: string; subtotalLineItemsQuantity: number; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } }
export async function listOrders(shop: ReadOnlyShopify, query: string, limit: number): Promise<{ rows: OrderRow[]; ids: string[] }> {
  const data = await shop.graphql<{ orders: { nodes: RawOrder[] } }>(ORDERS_QUERY, { query, first: limit })
  const nodes = data.orders.nodes
  return { ids: nodes.map(order => order.id), rows: nodes.map(order => ({ name: order.name, createdAt: order.createdAt, payment: order.displayFinancialStatus, fulfilment: order.displayFulfillmentStatus, total: `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`, items: order.subtotalLineItemsQuantity })) }
}
export async function listOrderIds(shop: ReadOnlyShopify, query: string, max = 300): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = []
  let after: string | null = null
  while (ids.length < max) {
    const data: { orders: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await shop.graphql(ORDER_IDS_QUERY, { query, after })
    ids.push(...data.orders.nodes.map(node => node.id))
    if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) return { ids: ids.slice(0, max), truncated: ids.length > max }
    after = data.orders.pageInfo.endCursor
  }
  return { ids: ids.slice(0, max), truncated: true }
}
export async function countOrders(shop: ReadOnlyShopify, query: string): Promise<number> {
  const data = await shop.graphql<{ ordersCount: { count: number } | null }>(COUNT_QUERY, { query })
  if (!data.ordersCount) throw new Error('Shopify returned no count.')
  return data.ordersCount.count
}
export interface StockRow { sku: string | null; product: string; variant: string; quantity: number }
export async function lowStock(shop: ReadOnlyShopify, threshold: number, limit: number): Promise<StockRow[]> {
  const data = await shop.graphql<{ productVariants: { nodes: { sku: string | null; title: string; inventoryQuantity: number; product: { title: string } }[] } }>(LOW_STOCK_QUERY, { query: `inventory_quantity:<=${threshold} product_status:active`, first: limit })
  return data.productVariants.nodes.map(node => ({ sku: node.sku, product: node.product.title, variant: node.title, quantity: node.inventoryQuantity }))
}
```

- [ ] **Step 4: The numbers**

```ts
// src/lib/home/numbers.ts
import { countOrders, listOrderIds, OPEN_PAID_QUERY, orderQuery, type ReadOnlyShopify } from './shopify-reads'
import { withTimeout } from './probes'

export interface HomeNumbers { ordersToday: number | null; paidUnfulfilled: number | null; awaitingQc: number | null; awaitingQcCapped: boolean; awaitingTracking: number | null; openShortages: number | null; problems: string[]; computedAt: string }
export interface NumberDeps { shop: ReadOnlyShopify | null; qcPassed(ids: string[]): Promise<Record<string, boolean>>; openParcels(): Promise<number>; openShortages(): Promise<number>; now: () => Date }

export const NUMBERS_TIMEOUT_MS = 10_000

/** The five headline numbers. A check that fails or hangs past NUMBERS_TIMEOUT_MS is a null plus a sentence in `problems`; the page never throws or hangs over one of them. */
export async function computeNumbers(deps: NumberDeps): Promise<HomeNumbers> {
  const problems: string[] = []
  const attempt = async <T>(label: string, work: () => Promise<T>): Promise<T | null> => {
    try { return await withTimeout(work(), NUMBERS_TIMEOUT_MS) }
    catch (error) {
      const reason = error instanceof Error ? (error.name === 'TimeoutError' ? 'timed out' : error.message) : String(error)
      problems.push(`${label}: ${reason}`)
      return null
    }
  }
  const shop = deps.shop
  if (!shop) problems.push('Shopify is not configured.')
  const [ordersToday, paidUnfulfilled, awaiting, awaitingTracking, openShortages] = await Promise.all([
    shop ? attempt('orders today', () => countOrders(shop, orderQuery('today', deps.now()))) : null,
    shop ? attempt('paid unfulfilled', () => countOrders(shop, OPEN_PAID_QUERY)) : null,
    shop ? attempt('awaiting QC', async () => { const { ids, truncated } = await listOrderIds(shop, OPEN_PAID_QUERY, 300); const passed = await deps.qcPassed(ids); return { count: ids.filter(id => !passed[id]).length, truncated } }) : null,
    attempt('awaiting tracking', deps.openParcels),
    attempt('open shortages', deps.openShortages),
  ])
  return { ordersToday, paidUnfulfilled, awaitingQc: awaiting?.count ?? null, awaitingQcCapped: awaiting?.truncated ?? false, awaitingTracking, openShortages, problems, computedAt: deps.now().toISOString() }
}
```

- [ ] **Step 5: The probe state store**

```ts
// src/lib/home/probe-store.ts
import type { ProbeLight, ProbeStateStore, ProbeStatus } from './probes'

type Result<T> = PromiseLike<{ error: { message: string } | null } & T>
/** The slice of a Supabase client the store touches; `supabaseServer()` satisfies it, and tests pass a fake. */
export interface ProbeStoreDb { from(table: string): { select(columns: string): Result<{ data: Record<string, unknown>[] | null }>; upsert(row: Record<string, unknown>, options: { onConflict: string }): Result<object>; insert(row: Record<string, unknown>): Result<object> } }

/** Last change per probe in `home_probe_state`, plus one `home.probe_changed` events row per change (D137). */
export function supabaseProbeStore(db: ProbeStoreDb): ProbeStateStore {
  return {
    async load() {
      const { data, error } = await db.from('home_probe_state').select('probe_key,status,since')
      if (error) throw new Error(error.message)
      return Object.fromEntries((data ?? []).map(row => [String(row.probe_key), { status: row.status as ProbeStatus, since: String(row.since) }]))
    },
    async changed(light: ProbeLight, previous: ProbeStatus | null) {
      const { error } = await db.from('home_probe_state').upsert({ probe_key: light.key, status: light.status, detail: light.detail, since: light.since, checked_at: light.checkedAt }, { onConflict: 'probe_key' })
      if (error) throw new Error(error.message)
      await db.from('events').insert({ entity_type: 'home_probe', event: 'home.probe_changed', detail: { key: light.key, label: light.label, from: previous, to: light.status, reason: light.detail }, actor: 'home' })
    },
  }
}
```
If TypeScript rejects `supabaseServer()` as a `ProbeStoreDb` in `server.ts`, pass `supabaseServer() as unknown as ProbeStoreDb` and say so in the report.

- [ ] **Step 6: The server wiring**

```ts
// src/lib/home/server.ts
import 'server-only'
import { listParcels } from '@/lib/dispatch/store'
import { qcOrderStatuses } from '@/lib/qc/server'
import { listShortages } from '@/lib/qc/shortages'
import { ShopifyClient } from '@/lib/shopify/client'
import { supabaseServer } from '@/lib/supabase/server'
import { n8nFromEnv } from './n8n'
import { computeNumbers, type HomeNumbers } from './numbers'
import { probeDefs } from './probes.config'
import { supabaseProbeStore } from './probe-store'
import { cached, probeHttp, probeN8n, probeShopify, probeSupabase, runProbes, type ProbeLight } from './probes'
import { readOnlyShopify, type ReadOnlyShopify } from './shopify-reads'

let shopifyClient: ShopifyClient | null = null
/** One client per process: its token manager caches the 24 h token, so a 30 s probe cycle never re-mints. Null when Shopify is not configured. */
export function homeShopify(): ShopifyClient | null { try { return (shopifyClient ??= new ShopifyClient()) } catch { return null } }
export function homeReadOnlyShopify(): ReadOnlyShopify | null { const client = homeShopify(); return client ? readOnlyShopify(client) : null }
export async function qcPassed(ids: string[]): Promise<Record<string, boolean>> { const statuses = await qcOrderStatuses(ids); return Object.fromEntries(ids.map(id => [id, statuses[id]?.status === 'passed'])) }

const lights = cached(30_000, () => {
  const n8n = n8nFromEnv(), shopify = homeShopify(), now = Date.now
  const off = (detail: string) => Promise.resolve({ status: 'red' as const, detail, ms: 0 })
  return runProbes(probeDefs(), def =>
    def.kind === 'http' ? probeHttp(def.target, { fetchImpl: fetch, now })
    : def.kind === 'n8n' ? (n8n ? probeN8n(def.target, n8n, now) : off('N8N_URL / N8N_API_KEY not set'))
    : def.kind === 'supabase' ? probeSupabase(supabaseServer(), now)
    : shopify ? probeShopify(shopify, now) : off('Shopify not configured'), supabaseProbeStore(supabaseServer()), now)
})
const numbers = cached(60_000, () => computeNumbers({ shop: homeReadOnlyShopify(), qcPassed, openParcels: async () => (await listParcels(1)).open.length, openShortages: async () => (await listShortages(1)).open.length, now: () => new Date() }))

export interface HomeSnapshot { lights: ProbeLight[]; numbers: HomeNumbers }
/** Lights at most 30 s old, numbers at most 60 s old, per process. */
export async function homeSnapshot(): Promise<HomeSnapshot> {
  const now = Date.now()
  const [l, n] = await Promise.all([lights(now), numbers(now)])
  return { lights: l, numbers: n }
}
```
If TypeScript rejects `supabaseServer()` as a `ProbeDb` or a `ProbeStoreDb`, pass `supabaseServer() as unknown as <that type>` and say so in the report.

- [ ] **Step 7: Run the tests, typecheck, lint**

Run: `npx vitest run tests/home-shopify-reads.test.ts tests/home-numbers.test.ts tests/home-probe-store.test.ts && npm run typecheck && npx eslint src/lib/home/shopify-reads.ts src/lib/home/numbers.ts src/lib/home/probe-store.ts src/lib/home/server.ts tests/home-shopify-reads.test.ts tests/home-numbers.test.ts tests/home-probe-store.test.ts`
Expected: PASS; clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/home/shopify-reads.ts src/lib/home/numbers.ts src/lib/home/probe-store.ts src/lib/home/server.ts tests/home-shopify-reads.test.ts tests/home-numbers.test.ts tests/home-probe-store.test.ts
git commit -m "feat(home): read-only Shopify wrapper, the five numbers, and the cached server snapshot"
```
