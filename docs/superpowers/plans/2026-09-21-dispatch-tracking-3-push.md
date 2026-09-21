# Dispatch Tracking — Implementation Plan, part 3 of 5 (push orchestration)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, architecture, tech stack, file index and Global Constraints:** see part 1 (`2026-09-21-dispatch-tracking-1-types-schema.md`). Every constraint there applies here. Tasks 1–4 must be complete first.

---

### Task 5: Push orchestration (injected dependencies)

**Files:**
- Create: `src/lib/dispatch/push.ts`
- Test: `tests/dispatch-push.test.ts`

**Interfaces:**
- Consumes: `planPush`, `confirmsPush` (Task 4); `Carrier`, `DispatchOrderSnapshot`, `ParcelRow` (Task 1).
- Produces: `PushStore`, `PushDeps`, `PushResult`, `pushParcel(parcelId: string, by: string, deps: PushDeps): Promise<PushResult[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dispatch-push.test.ts
import { describe, expect, it, vi } from 'vitest'
import { pushParcel, type PushDeps, type PushStore } from '@/lib/dispatch/push'
import type { DispatchOrderSnapshot, ParcelOrderRow, ParcelRow } from '@/lib/dispatch/types'

const row = (n: number, changes: Partial<ParcelOrderRow> = {}): ParcelOrderRow => ({ id: `r${n}`, parcel_id: 'p1', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position: n - 1, status: 'staged', fulfillment_id: null, error: null, push_started_at: null, finished_at: null, ...changes })
const parcelOf = (orders: ParcelOrderRow[], changes: Partial<ParcelRow> = {}): ParcelRow => ({ id: 'p1', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op@example.test', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders, ...changes })
const snapshot = (n: number, changes: Partial<DispatchOrderSnapshot> = {}): DispatchOrderSnapshot => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, closed: false, cancelledAt: null, fulfillmentOrdersComplete: true, fulfillments: [], fulfillmentOrders: [{ id: `fo${n}`, status: 'IN_PROGRESS', canFulfil: true, remaining: 2, locationId: 'loc1', complete: true }], ...changes })

function harness(parcel: ParcelRow, shopify: Record<string, DispatchOrderSnapshot>, fulfilBehaviour: 'lands' | 'throws-but-lands' | 'throws' | 'silent' = 'lands') {
  const events: string[] = []
  const find = (id: string) => parcel.orders.find(item => item.id === id)!
  const store: PushStore = {
    loadParcel: async () => parcel,
    claim: async id => { const item = find(id); if (item.status === 'pushing' || item.status === 'fulfilled') return false; item.status = 'pushing'; return true },
    fail: async (id, message) => { Object.assign(find(id), { status: 'failed', error: message }) },
    finish: async (id, _request, result) => { Object.assign(find(id), 'fulfillmentId' in result ? { status: 'fulfilled', fulfillment_id: result.fulfillmentId, error: null } : { status: 'failed', error: result.error }) },
    markPushed: async (_id, by, now) => { parcel.pushed_by = by; parcel.pushed_at = now.toISOString() },
    record: async (_id, event) => { events.push(event) },
  }
  const land = (input: { fulfillmentOrderIds: readonly string[]; company: string; number: string }) => {
    const order = Object.values(shopify).find(item => item.fulfillmentOrders.some(fo => input.fulfillmentOrderIds.includes(fo.id)))!
    order.fulfillments.push({ id: `f-${order.name}`, status: 'SUCCESS', tracking: [{ company: input.company, number: input.number }] })
    for (const fo of order.fulfillmentOrders) if (input.fulfillmentOrderIds.includes(fo.id)) Object.assign(fo, { status: 'CLOSED', remaining: 0 })
  }
  const fulfil = vi.fn(async (input: Parameters<PushDeps['fulfil']>[0]) => {
    if (fulfilBehaviour === 'lands' || fulfilBehaviour === 'throws-but-lands') land(input)
    if (fulfilBehaviour === 'throws' || fulfilBehaviour === 'throws-but-lands') throw new Error('Shopify timed out.')
    return { id: 'f-new' }
  })
  let n = 0
  const deps: PushDeps = { store, fulfil, readOrder: async id => structuredClone(shopify[id]), now: () => new Date('2026-09-21T06:00:00Z'), newId: () => `req-${++n}` }
  return { deps, fulfil, events, parcel }
}
const two = () => ({ 'gid://shopify/Order/1': snapshot(1), 'gid://shopify/Order/2': snapshot(2) })

describe('pushParcel', () => {
  it('fulfils every order of a parcel with the shared number and records who pushed', async () => {
    const h = harness(parcelOf([row(1), row(2)]), two())
    const results = await pushParcel('p1', 'owner@example.test', h.deps)
    expect(results.map(r => [r.orderName, r.status])).toEqual([['Qimati1', 'fulfilled'], ['Qimati2', 'fulfilled']])
    expect(h.fulfil.mock.calls.map(([input]) => input)).toEqual([{ fulfillmentOrderIds: ['fo1'], company: 'DTDC', number: 'X1234567' }, { fulfillmentOrderIds: ['fo2'], company: 'DTDC', number: 'X1234567' }])
    expect(h.parcel.pushed_by).toBe('owner@example.test')
    expect(h.events).toEqual(['dispatch.pushed'])
  })
  it('fulfils nothing when any order of the parcel fails the pre-check', async () => {
    const h = harness(parcelOf([row(1), row(2)]), { ...two(), 'gid://shopify/Order/2': snapshot(2, { cancelledAt: '2026-09-21T01:00:00Z' }) })
    const results = await pushParcel('p1', 'owner@example.test', h.deps)
    expect(h.fulfil).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ orderName: 'Qimati1', status: 'failed' }); expect(results[0].message).toMatch(/Qimati2/)
    expect(results[1].message).toMatch(/cancelled/)
    expect(h.parcel.orders.map(o => o.status)).toEqual(['staged', 'failed'])
    expect(h.parcel.pushed_at).toBeNull(); expect(h.events).toEqual(['dispatch.failed'])
  })
  it('trusts the re-read, not the response: a lost response that landed is a success', async () => {
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) }, 'throws-but-lands')
    expect((await pushParcel('p1', 'op', h.deps))[0].status).toBe('fulfilled')
    expect(h.fulfil).toHaveBeenCalledTimes(1)
  })
  it('keeps the first order fulfilled when a later one fails, and leaves that one for another push', async () => {
    const shopify = two(); const h = harness(parcelOf([row(1), row(2)]), shopify)
    h.fulfil.mockImplementationOnce(h.fulfil.getMockImplementation()!).mockImplementationOnce(async () => { throw new Error('Shopify timed out.') })
    const results = await pushParcel('p1', 'op', h.deps)
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'failed']); expect(results[1].message).toMatch(/timed out/)
    expect(h.parcel.orders.map(o => o.status)).toEqual(['fulfilled', 'failed'])
    expect(h.parcel.pushed_at).not.toBeNull(); expect(h.events).toEqual(['dispatch.failed'])
  })
  it('does not call a push done until Shopify shows the fulfilment', async () => {
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': snapshot(1) }, 'silent')
    const [result] = await pushParcel('p1', 'op', h.deps)
    expect(result.status).toBe('failed'); expect(result.message).toMatch(/did not confirm/)
  })
  it('stands aside for an order another push holds', async () => {
    const h = harness(parcelOf([row(1, { status: 'pushing' })]), { 'gid://shopify/Order/1': snapshot(1) })
    expect((await pushParcel('p1', 'op', h.deps))[0].status).toBe('busy'); expect(h.fulfil).not.toHaveBeenCalled()
  })
  it('records an order someone already fulfilled with the same number, without fulfilling again', async () => {
    const already = snapshot(1, { fulfillmentOrders: [{ id: 'fo1', status: 'CLOSED', canFulfil: false, remaining: 0, locationId: 'loc1', complete: true }], fulfillments: [{ id: 'f-admin', status: 'SUCCESS', tracking: [{ company: 'DTDC', number: 'X1234567' }] }] })
    const h = harness(parcelOf([row(1)]), { 'gid://shopify/Order/1': already })
    expect((await pushParcel('p1', 'op', h.deps))[0].status).toBe('fulfilled'); expect(h.fulfil).not.toHaveBeenCalled()
    expect(h.parcel.orders[0].fulfillment_id).toBe('f-admin')
  })
  it('refuses a parcel without a number or a carrier', async () => {
    await expect(pushParcel('p1', 'op', harness(parcelOf([row(1)], { carrier: null }), {}).deps)).rejects.toThrow(/tracking number and carrier/)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/dispatch-push.test.ts`
Expected: FAIL — cannot resolve `@/lib/dispatch/push`.

- [ ] **Step 3: Implement**

```ts
// src/lib/dispatch/push.ts
import { confirmsPush, planPush } from './plan'
import type { Carrier, DispatchOrderSnapshot, ParcelRow, PushPlan } from './types'

export interface PushStore {
  loadParcel(parcelId: string): Promise<ParcelRow | null>
  /** staged | failed | a `pushing` row older than two minutes → pushing. False when another push holds the row. */
  claim(rowId: string, requestId: string, now: Date): Promise<boolean>
  /** Pre-check refusal; only touches a row nobody is pushing. */
  fail(rowId: string, message: string): Promise<void>
  /** Settles the row this push claimed; a row claimed by a different request is left alone. */
  finish(rowId: string, requestId: string, result: { fulfillmentId: string } | { error: string }, now: Date): Promise<void>
  markPushed(parcelId: string, by: string, now: Date): Promise<void>
  record(parcelId: string, event: string, detail: Record<string, unknown>, by: string): Promise<void>
}
export interface PushDeps {
  store: PushStore
  readOrder(orderId: string): Promise<DispatchOrderSnapshot>
  /** Must be a single-attempt call: a blind retry is never sent. */
  fulfil(input: { fulfillmentOrderIds: readonly string[]; company: Carrier; number: string }): Promise<{ id: string }>
  now(): Date
  newId(): string
}
export interface PushResult { orderId: string; orderName: string; status: 'fulfilled' | 'failed' | 'busy'; message: string }

const CHECK = 'Check the order in Shopify, then push again.'

export async function pushParcel(parcelId: string, by: string, deps: PushDeps): Promise<PushResult[]> {
  const parcel = await deps.store.loadParcel(parcelId)
  if (!parcel) throw new Error('This parcel no longer exists. Reload Dispatch.')
  if (!parcel.tracking_number || !parcel.carrier) throw new Error('Add a tracking number and carrier before pushing.')
  const number = parcel.tracking_number, carrier = parcel.carrier
  const pending = parcel.orders.filter(item => item.status !== 'fulfilled').sort((a, b) => a.position - b.position)
  if (pending.length === 0) return []

  // 1. The whole parcel is checked against fresh Shopify reads before anything is written.
  const plans = new Map<string, PushPlan>()
  for (const item of pending) plans.set(item.id, planPush(await deps.readOrder(item.order_id), carrier, number))
  const refused = pending.filter(item => plans.get(item.id)!.kind === 'refuse')
  if (refused.length) {
    const results: PushResult[] = []
    for (const item of pending) {
      const plan = plans.get(item.id)!
      const message = plan.kind === 'refuse' ? plan.reason : `Not pushed: ${refused[0].order_name} in the same parcel was refused.`
      if (plan.kind === 'refuse') await deps.store.fail(item.id, message)
      results.push({ orderId: item.order_id, orderName: item.order_name, status: 'failed', message })
    }
    await audit(deps, parcelId, 'dispatch.failed', { stage: 'precheck', tracking: number, carrier, refused: refused.map(item => item.order_name) }, by)
    return results
  }

  // 2. One order at a time. Only a fresh read decides the outcome: a mutation may land although its response was lost.
  const results: PushResult[] = []
  for (const item of pending) {
    const plan = plans.get(item.id)!
    const requestId = deps.newId()
    if (!(await deps.store.claim(item.id, requestId, deps.now()))) { results.push({ orderId: item.order_id, orderName: item.order_name, status: 'busy', message: 'Another push is handling this order.' }); continue }
    let fulfillmentId = plan.kind === 'done' ? plan.fulfillmentId : null
    let failure: string | null = null
    if (plan.kind === 'fulfil') {
      try { await deps.fulfil({ fulfillmentOrderIds: plan.fulfillmentOrderIds, company: carrier, number }) }
      catch (cause) { failure = cause instanceof Error ? cause.message : 'Shopify did not answer.' }
      try { fulfillmentId = confirmsPush(await deps.readOrder(item.order_id), carrier, number) }
      catch { failure ??= 'Shopify could not be re-read after the push.' }
    }
    if (fulfillmentId) {
      await deps.store.finish(item.id, requestId, { fulfillmentId }, deps.now())
      results.push({ orderId: item.order_id, orderName: item.order_name, status: 'fulfilled', message: `Fulfilled with ${carrier} ${number}.` })
    } else {
      const message = failure ? `${failure} ${CHECK}` : `Shopify did not confirm the fulfilment. ${CHECK}`
      await deps.store.finish(item.id, requestId, { error: message }, deps.now())
      results.push({ orderId: item.order_id, orderName: item.order_name, status: 'failed', message })
    }
  }
  if (results.some(result => result.status === 'fulfilled')) await deps.store.markPushed(parcelId, by, deps.now())
  await audit(deps, parcelId, results.every(result => result.status === 'fulfilled') ? 'dispatch.pushed' : 'dispatch.failed', { tracking: number, carrier, orders: results.map(result => ({ order: result.orderName, status: result.status })) }, by)
  return results
}

/** The fulfilment already happened; a failed audit write must not turn the result into an error. */
async function audit(deps: PushDeps, parcelId: string, event: string, detail: Record<string, unknown>, by: string): Promise<void> {
  try { await deps.store.record(parcelId, event, detail, by) } catch (cause) { console.error('dispatch audit write failed', event, cause) }
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/dispatch-push.test.ts && npm run typecheck`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dispatch/push.ts tests/dispatch-push.test.ts
git commit -m "feat(dispatch): push a parcel — whole-parcel pre-check, one order at a time, the re-read decides the outcome"
```


---

Continue with `2026-09-21-dispatch-tracking-4-store-actions.md`.
