# Dispatch Tracking — Implementation Plan, part 2 of 5 (Shopify reads and mutation, push decision)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, architecture, tech stack, file index and Global Constraints:** see part 1 (`2026-09-21-dispatch-tracking-1-types-schema.md`). Every constraint there applies here. Tasks 1–2 must be complete first.

---

### Task 3: Shopify reads and the fulfilment mutation

**Files:**
- Modify: `src/lib/shopify/qc-orders.ts:27` — export `PAID`
- Create: `src/lib/shopify/dispatch-orders.ts`
- Test: `tests/dispatch-orders.test.ts`

**Interfaces:**
- Consumes: `ShopifyClient.graphql<T>(query, variables)`, `orderGid(id)` from `@/lib/qc/validation`, types from Task 1.
- Produces: `dispatchShopifyError(error: unknown): string`; `listDispatchOrders(client): Promise<{ orders: DispatchOrderSummary[]; truncated: boolean }>`; `readDispatchOrder(client, id: string): Promise<DispatchOrderSnapshot>`; `createFulfillment(client, input: { fulfillmentOrderIds: readonly string[]; company: Carrier; number: string }): Promise<{ id: string }>`.

- [ ] **Step 1: Export the paid filter.** In `src/lib/shopify/qc-orders.ts` change `const PAID =` to `export const PAID =`. Nothing else in that file changes.

- [ ] **Step 2: Write the failing test**

```ts
// tests/dispatch-orders.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createFulfillment, dispatchShopifyError, listDispatchOrders, readDispatchOrder } from '@/lib/shopify/dispatch-orders'
import type { ShopifyClient } from '@/lib/shopify/client'

const client = (graphql: ReturnType<typeof vi.fn>) => ({ graphql }) as unknown as ShopifyClient
const listed = (n: number, statuses: string[], address: { name: string | null; zip: string | null; address1: string | null } | null = { name: 'R. Sharma', zip: '302001', address1: '12 MI Road' }) =>
  ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-09-21T05:00:00Z', shippingAddress: address, fulfillmentOrders: { nodes: statuses.map((status, i) => ({ id: `gid://shopify/FulfillmentOrder/${n}${i}`, status })) } })
const pageOf = (nodes: unknown[], next: string | null = null) => ({ orders: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next } } })

describe('listing In-progress orders', () => {
  it('keeps only orders with an IN_PROGRESS fulfilment order and follows every page', async () => {
    const graphql = vi.fn().mockResolvedValueOnce(pageOf([listed(1, ['IN_PROGRESS']), listed(2, ['OPEN'])], 'c1')).mockResolvedValueOnce(pageOf([listed(3, ['CLOSED', 'IN_PROGRESS']), listed(4, ['ON_HOLD'])]))
    const result = await listDispatchOrders(client(graphql))
    expect(result.orders.map(o => o.name)).toEqual(['Qimati1', 'Qimati3'])
    expect(result.truncated).toBe(false)
    expect(graphql.mock.calls[1][1].after).toBe('c1')
    expect(graphql.mock.calls[0][1].query).toContain('status:open')
    expect(graphql.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true)
  })
  it('hashes the destination instead of returning it, and matches the same address', async () => {
    const graphql = vi.fn().mockResolvedValueOnce(pageOf([listed(1, ['IN_PROGRESS']), listed(2, ['IN_PROGRESS'], { name: 'Other', zip: '302001', address1: '12, M.I. Road' }), listed(3, ['IN_PROGRESS'], null)]))
    const { orders } = await listDispatchOrders(client(graphql))
    expect(orders[0].addressKey).toMatch(/^[0-9a-f]{16}$/)
    expect(orders[0].addressKey).toBe(orders[1].addressKey)
    expect(orders[2]).toMatchObject({ customer: '—', addressKey: '' })
    expect(JSON.stringify(orders)).not.toContain('MI Road')
  })
  it('says so when the ten-page cap is hit', async () => {
    const graphql = vi.fn().mockResolvedValue(pageOf([listed(1, ['IN_PROGRESS'])], 'more'))
    expect((await listDispatchOrders(client(graphql))).truncated).toBe(true)
    expect(graphql).toHaveBeenCalledTimes(10)
  })
})

const fo = (changes = {}) => ({ id: 'gid://shopify/FulfillmentOrder/1', status: 'IN_PROGRESS', supportedActions: [{ action: 'CREATE_FULFILLMENT' }], assignedLocation: { location: { id: 'gid://shopify/Location/1' } }, lineItems: { nodes: [{ remainingQuantity: 2 }, { remainingQuantity: 0 }], pageInfo: { hasNextPage: false } }, ...changes })
describe('reading one order for a push', () => {
  it('maps fulfilment orders and fulfilments', async () => {
    const graphql = vi.fn().mockResolvedValue({ order: { id: 'gid://shopify/Order/1', name: 'Qimati1', closed: false, cancelledAt: null, fulfillments: [{ id: 'gid://shopify/Fulfillment/5', status: 'SUCCESS', trackingInfo: [{ company: 'DTDC', number: 'X1' }] }], fulfillmentOrders: { nodes: [fo(), fo({ id: 'gid://shopify/FulfillmentOrder/2', status: 'OPEN', supportedActions: [] })], pageInfo: { hasNextPage: false } } } })
    const order = await readDispatchOrder(client(graphql), '1')
    expect(graphql.mock.calls[0][1]).toEqual({ id: 'gid://shopify/Order/1' })
    expect(order.fulfillmentOrders[0]).toEqual({ id: 'gid://shopify/FulfillmentOrder/1', status: 'IN_PROGRESS', canFulfil: true, remaining: 2, locationId: 'gid://shopify/Location/1', complete: true })
    expect(order.fulfillmentOrders[1].canFulfil).toBe(false)
    expect(order.fulfillments).toEqual([{ id: 'gid://shopify/Fulfillment/5', status: 'SUCCESS', tracking: [{ company: 'DTDC', number: 'X1' }] }])
  })
  it('fails clearly when the order is gone', async () => { await expect(readDispatchOrder(client(vi.fn().mockResolvedValue({ order: null })), '1')).rejects.toThrow(/unavailable/) })
})

describe('the fulfilment mutation', () => {
  it('sends company, number, notifyCustomer and whole fulfilment orders', async () => {
    const graphql = vi.fn().mockResolvedValue({ fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/9' }, userErrors: [] } })
    expect(await createFulfillment(client(graphql), { fulfillmentOrderIds: ['gid://shopify/FulfillmentOrder/1'], company: 'DTDC', number: 'X1234567' })).toEqual({ id: 'gid://shopify/Fulfillment/9' })
    expect(graphql.mock.calls[0][1]).toEqual({ fulfillment: { notifyCustomer: true, trackingInfo: { company: 'DTDC', number: 'X1234567' }, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1' }] } })
  })
  it('turns userErrors into one sentence', async () => {
    const graphql = vi.fn().mockResolvedValue({ fulfillmentCreate: { fulfillment: null, userErrors: [{ field: null, message: 'Fulfillment order is not open.' }] } })
    await expect(createFulfillment(client(graphql), { fulfillmentOrderIds: ['x'], company: 'DTDC', number: 'X1234567' })).rejects.toThrow('Fulfillment order is not open.')
  })
  it('names the missing scopes', () => { expect(dispatchShopifyError(new Error('Access denied for fulfillmentOrders field.'))).toMatch(/write_merchant_managed_fulfillment_orders/) })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/dispatch-orders.test.ts`
Expected: FAIL — cannot resolve `@/lib/shopify/dispatch-orders`.

- [ ] **Step 4: Implement**

```ts
// src/lib/shopify/dispatch-orders.ts
import { createHash } from 'node:crypto'
import type { ShopifyClient } from './client'
import { PAID } from './qc-orders'
import { orderGid } from '@/lib/qc/validation'
import type { Carrier, DispatchOrderSnapshot, DispatchOrderSummary } from '@/lib/dispatch/types'

const MAX_PAGES = 10
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface RawAddress { name: string | null; zip: string | null; address1: string | null }
interface RawListed { id: string; name: string; createdAt: string; shippingAddress: RawAddress | null; fulfillmentOrders: { nodes: { id: string; status: string }[] } }
interface RawFulfillmentOrder { id: string; status: string; supportedActions: { action: string }[]; assignedLocation: { location: { id: string } | null } | null; lineItems: { nodes: { remainingQuantity: number }[]; pageInfo: { hasNextPage: boolean } } }
interface RawOrder { id: string; name: string; closed: boolean; cancelledAt: string | null; fulfillments: { id: string; status: string; trackingInfo: { company: string | null; number: string | null }[] }[]; fulfillmentOrders: { nodes: RawFulfillmentOrder[]; pageInfo: { hasNextPage: boolean } } }

export function dispatchShopifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Shopify did not answer.'
  if (/access denied|fulfillment_orders|permission|access scope/i.test(message)) return 'Loupe cannot read or fulfil orders yet. In the Shopify Dev Dashboard add read_merchant_managed_fulfillment_orders and write_merchant_managed_fulfillment_orders to the Loupe app, re-approve it, then reload Dispatch.'
  return message
}

/** Same destination → same key. A hash, so no address leaves the server. */
function addressKey(address: RawAddress | null): string {
  if (!address) return ''
  const plain = [address.zip, address.address1].map(part => (part ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')).join('|')
  return createHash('sha256').update(plain).digest('hex').slice(0, 16)
}

/**
 * Open, paid orders with a fulfilment order In progress. Shopify rejects `fulfillment_status:in_progress`
 * as a search term (verified 2026-09-11), so the filter runs on the returned fulfilment orders.
 */
export async function listDispatchOrders(client: ShopifyClient): Promise<{ orders: DispatchOrderSummary[]; truncated: boolean }> {
  const query = `status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) ${PAID}`
  const orders: DispatchOrderSummary[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { orders: { nodes: RawListed[]; pageInfo: PageInfo } } = await client.graphql(`
      query LoupeDispatchOrders($query: String!, $after: String) {
        orders(first: 30, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes { id name createdAt shippingAddress { name zip address1 } fulfillmentOrders(first: 10) { nodes { id status } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { query, after })
    for (const order of data.orders.nodes) {
      if (!order.fulfillmentOrders.nodes.some(item => item.status === 'IN_PROGRESS')) continue
      orders.push({ id: order.id, name: order.name, createdAt: order.createdAt, customer: order.shippingAddress?.name?.trim() || '—', addressKey: addressKey(order.shippingAddress) })
    }
    if (!data.orders.pageInfo.hasNextPage) return { orders, truncated: false }
    if (!data.orders.pageInfo.endCursor) throw new Error('Shopify returned an incomplete order page. Reload Dispatch.')
    after = data.orders.pageInfo.endCursor
  }
  return { orders, truncated: true }
}

export async function readDispatchOrder(client: ShopifyClient, id: string): Promise<DispatchOrderSnapshot> {
  const data = await client.graphql<{ order: RawOrder | null }>(`
    query LoupeDispatchOrder($id: ID!) {
      order(id: $id) {
        id name closed cancelledAt
        fulfillments(first: 50) { id status trackingInfo { company number } }
        fulfillmentOrders(first: 10) {
          nodes { id status supportedActions { action } assignedLocation { location { id } } lineItems(first: 100) { nodes { remainingQuantity } pageInfo { hasNextPage } } }
          pageInfo { hasNextPage }
        }
      }
    }`, { id: orderGid(id) })
  const order = data.order
  if (!order) throw new Error('This order is unavailable. It may have been deleted, or the app cannot read orders this old.')
  return {
    id: order.id, name: order.name, closed: order.closed, cancelledAt: order.cancelledAt,
    fulfillmentOrdersComplete: !order.fulfillmentOrders.pageInfo.hasNextPage,
    fulfillmentOrders: order.fulfillmentOrders.nodes.map(item => ({
      id: item.id, status: item.status, canFulfil: item.supportedActions.some(action => action.action === 'CREATE_FULFILLMENT'),
      remaining: item.lineItems.nodes.reduce((sum, line) => sum + Math.max(0, line.remainingQuantity), 0),
      locationId: item.assignedLocation?.location?.id ?? null, complete: !item.lineItems.pageInfo.hasNextPage,
    })),
    fulfillments: order.fulfillments.map(item => ({ id: item.id, status: item.status, tracking: item.trackingInfo.map(info => ({ company: info.company, number: info.number })) })),
  }
}

/** Fulfils every remaining item of the given fulfilment orders. Call only with a single-attempt client. */
export async function createFulfillment(client: ShopifyClient, input: { fulfillmentOrderIds: readonly string[]; company: Carrier; number: string }): Promise<{ id: string }> {
  const data = await client.graphql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] } }>(`
    mutation LoupeDispatchFulfil($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } }
    }`, { fulfillment: { notifyCustomer: true, trackingInfo: { company: input.company, number: input.number }, lineItemsByFulfillmentOrder: input.fulfillmentOrderIds.map(id => ({ fulfillmentOrderId: id })) } })
  if (data.fulfillmentCreate.userErrors.length) throw new Error(data.fulfillmentCreate.userErrors.map(error => error.message).join(' '))
  if (!data.fulfillmentCreate.fulfillment) throw new Error('Shopify returned no fulfilment.')
  return { id: data.fulfillmentCreate.fulfillment.id }
}
```

- [ ] **Step 5: Run the tests, the QC order tests (PAID export) and typecheck**

Run: `npx vitest run tests/dispatch-orders.test.ts tests/qc-orders.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Confirm the single-attempt client.** Read `graphql()` in `src/lib/shopify/client.ts` and confirm that `retryDelaysMs: [0]` yields exactly one HTTP attempt (the default `[0, 1000, 3000, 8000]` is "one attempt plus three retries"). If the loop treats the array differently, record the correct single-attempt value in `docs/DECISIONS.md` and use it in Task 7 (`pushParcelAction`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/shopify/qc-orders.ts src/lib/shopify/dispatch-orders.ts tests/dispatch-orders.test.ts
git commit -m "feat(dispatch): list In-progress orders, read one order for a push, fulfilmentCreate with tracking"
```


---

### Task 4: The push decision (pure)

**Files:**
- Create: `src/lib/dispatch/plan.ts`
- Test: `tests/dispatch-plan.test.ts`

**Interfaces:**
- Consumes: `DispatchOrderSnapshot`, `PushPlan`, `Carrier` (Task 1).
- Produces: `planPush(order: DispatchOrderSnapshot, carrier: Carrier, number: string): PushPlan`; `confirmsPush(order: DispatchOrderSnapshot, carrier: Carrier, number: string): string | null` (the confirming fulfilment id).

- [ ] **Step 1: Write the failing test**

```ts
// tests/dispatch-plan.test.ts
import { describe, expect, it } from 'vitest'
import { confirmsPush, planPush } from '@/lib/dispatch/plan'
import type { DispatchFulfillmentOrder, DispatchOrderSnapshot } from '@/lib/dispatch/types'

const fo = (changes: Partial<DispatchFulfillmentOrder> = {}): DispatchFulfillmentOrder => ({ id: 'fo1', status: 'IN_PROGRESS', canFulfil: true, remaining: 3, locationId: 'loc1', complete: true, ...changes })
const order = (changes: Partial<DispatchOrderSnapshot> = {}): DispatchOrderSnapshot => ({ id: 'gid://shopify/Order/1', name: 'Qimati1', closed: false, cancelledAt: null, fulfillmentOrders: [fo()], fulfillmentOrdersComplete: true, fulfillments: [], ...changes })
const done = (company: string, number: string, status = 'SUCCESS') => ({ id: 'f1', status, tracking: [{ company, number }] })
const reason = (snapshot: DispatchOrderSnapshot) => { const plan = planPush(snapshot, 'DTDC', 'X1234567'); return plan.kind === 'refuse' ? plan.reason : plan.kind }

describe('planPush', () => {
  it('fulfils every eligible In-progress fulfilment order and nothing else', () => {
    expect(planPush(order({ fulfillmentOrders: [fo(), fo({ id: 'fo2', status: 'OPEN' }), fo({ id: 'fo3' }), fo({ id: 'fo4', status: 'ON_HOLD' })] }), 'DTDC', 'X1234567')).toEqual({ kind: 'fulfil', fulfillmentOrderIds: ['fo1', 'fo3'] })
  })
  it('refuses cancelled and archived orders', () => { expect(reason(order({ cancelledAt: '2026-09-21T00:00:00Z' }))).toMatch(/cancelled/); expect(reason(order({ closed: true }))).toMatch(/archived/) })
  it('refuses when nothing is In progress, naming a hold', () => {
    expect(reason(order({ fulfillmentOrders: [fo({ status: 'OPEN' })] }))).toMatch(/Mark it In progress/)
    expect(reason(order({ fulfillmentOrders: [fo({ status: 'ON_HOLD' })] }))).toMatch(/on hold/)
    expect(reason(order({ fulfillmentOrders: [fo({ remaining: 0 })] }))).toMatch(/Mark it In progress/)
    expect(reason(order({ fulfillmentOrders: [fo({ canFulfil: false })] }))).toMatch(/Mark it In progress/)
  })
  it('counts an identical existing fulfilment as done', () => { expect(planPush(order({ fulfillmentOrders: [fo({ status: 'CLOSED', remaining: 0 })], fulfillments: [done('DTDC', 'X1234567')] }), 'DTDC', 'X1234567')).toEqual({ kind: 'done', fulfillmentId: 'f1' }) })
  it('never overwrites a different tracking number', () => { expect(reason(order({ fulfillmentOrders: [fo({ status: 'CLOSED', remaining: 0 })], fulfillments: [done('India Post', 'ER999999999IN')] }))).toMatch(/already fulfilled with India Post ER999999999IN/) })
  it('ignores a cancelled fulfilment', () => { expect(planPush(order({ fulfillments: [done('DTDC', 'X1234567', 'CANCELLED')] }), 'DTDC', 'X1234567').kind).toBe('fulfil') })
  it('fulfils the In-progress remainder of a partly shipped order', () => { expect(planPush(order({ fulfillments: [done('India Post', 'ER111111111IN')] }), 'DTDC', 'X1234567')).toEqual({ kind: 'fulfil', fulfillmentOrderIds: ['fo1'] }) })
  it('refuses what it cannot see completely or fulfil in one call', () => {
    expect(reason(order({ fulfillmentOrdersComplete: false }))).toMatch(/too large/)
    expect(reason(order({ fulfillmentOrders: [fo({ complete: false })] }))).toMatch(/too large/)
    expect(reason(order({ fulfillmentOrders: [fo(), fo({ id: 'fo2', locationId: 'loc2' })] }))).toMatch(/two locations/)
  })
})
describe('confirmsPush', () => {
  it('needs a successful fulfilment with exactly the sent company and number', () => {
    expect(confirmsPush(order({ fulfillments: [done('DTDC', 'X1234567')] }), 'DTDC', 'X1234567')).toBe('f1')
    expect(confirmsPush(order({ fulfillments: [done('DTDC', 'X1234567', 'PENDING')] }), 'DTDC', 'X1234567')).toBeNull()
    expect(confirmsPush(order({ fulfillments: [done('DTDC', 'X7654321')] }), 'DTDC', 'X1234567')).toBeNull()
    expect(confirmsPush(order({ fulfillments: [{ id: 'f1', status: 'SUCCESS', tracking: [{ company: 'DTDC', number: 'X1234567' }, { company: 'DTDC', number: 'X2' }] }] }), 'DTDC', 'X1234567')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/dispatch-plan.test.ts`
Expected: FAIL — cannot resolve `@/lib/dispatch/plan`.

- [ ] **Step 3: Implement**

```ts
// src/lib/dispatch/plan.ts
import type { Carrier, DispatchOrderSnapshot, PushPlan } from './types'

const refuse = (reason: string): PushPlan => ({ kind: 'refuse', reason })

/** What one order needs, decided from a fresh Shopify read. Pure: no I/O, no clock. */
export function planPush(order: DispatchOrderSnapshot, carrier: Carrier, number: string): PushPlan {
  if (order.cancelledAt) return refuse(`${order.name} is cancelled. Do not ship it.`)
  if (order.closed) return refuse(`${order.name} is archived in Shopify.`)
  if (!order.fulfillmentOrdersComplete || order.fulfillmentOrders.some(item => !item.complete)) return refuse(`${order.name} is too large to fulfil from Loupe. Fulfil it in Shopify.`)
  const eligible = order.fulfillmentOrders.filter(item => item.status === 'IN_PROGRESS' && item.canFulfil && item.remaining > 0)
  if (eligible.length === 0) {
    const active = order.fulfillments.filter(item => item.status !== 'CANCELLED')
    const same = active.find(item => item.tracking.some(info => info.company === carrier && info.number === number))
    if (same) return { kind: 'done', fulfillmentId: same.id }
    const other = active.flatMap(item => item.tracking).find(info => info.number)
    if (other) return refuse(`${order.name} is already fulfilled with ${other.company ?? 'another carrier'} ${other.number}.`)
    if (order.fulfillmentOrders.some(item => item.status === 'ON_HOLD')) return refuse(`${order.name} is on hold in Shopify.`)
    return refuse(`${order.name} has nothing In progress to fulfil. Mark it In progress in Shopify.`)
  }
  if (new Set(eligible.map(item => item.locationId)).size > 1) return refuse(`${order.name} has In-progress items at two locations. Fulfil it in Shopify.`)
  return { kind: 'fulfil', fulfillmentOrderIds: eligible.map(item => item.id) }
}

/** After a push: the id of a SUCCESS fulfilment carrying exactly the sent company and number, else null. */
export function confirmsPush(order: DispatchOrderSnapshot, carrier: Carrier, number: string): string | null {
  return order.fulfillments.find(item => item.status === 'SUCCESS' && item.tracking.length === 1 && item.tracking[0].company === carrier && item.tracking[0].number === number)?.id ?? null
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/dispatch-plan.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dispatch/plan.ts tests/dispatch-plan.test.ts
git commit -m "feat(dispatch): pure push decision — In-progress only, identical fulfilment is done, never overwrite tracking"
```

---

Continue with `2026-09-21-dispatch-tracking-3-push.md`.
