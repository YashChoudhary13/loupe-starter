# Dispatch Tracking — Implementation Plan, part 4 of 5 (Supabase store, server actions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, architecture, tech stack, file index and Global Constraints:** see part 1 (`2026-09-21-dispatch-tracking-1-types-schema.md`). Every constraint there applies here. Tasks 1–5 must be complete first.

---

### Task 6: Supabase store (staging, grouping, lists, push rows)

**Files:**
- Create: `src/lib/dispatch/store.ts`
- Test: `tests/dispatch-store.test.ts`

**Interfaces:**
- Consumes: `supabaseServer()`, `ShopifyClient().config.storeDomain`, `orderGid`, `normalizeTracking`, `trackingProblem`, `resolveCarrier`, `PushStore`.
- Produces: `listParcels(days?: number): Promise<{ open: ParcelRow[]; recent: ParcelRow[] }>`; `stageTracking(input: StageInput): Promise<void>`; `groupOrder(input: GroupInput): Promise<void>`; `ungroupOrder(input: { orderId: string; by: string }): Promise<void>`; `discardParcel(input: { parcelId: string; by: string }): Promise<void>`; `supabasePushStore(): PushStore`; `STALE_PUSH_MS`.
  `StageInput = { orderId: string; orderName: string; tracking: string; carrier?: string; by: string }`, `GroupInput = { primaryOrderId: string; primaryOrderName: string; orderId: string; orderName: string; by: string }`.

- [ ] **Step 1: Write the failing test** (a recording query builder; responses are queued in call order)

```ts
// tests/dispatch-store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ queue: [] as { data?: unknown; error?: unknown }[], calls: [] as { table: string; method: string; args: unknown[] }[] }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { config = { storeDomain: 'dispatch-test.myshopify.com' } } }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: (table: string) => {
  const next = () => Promise.resolve(db.queue.shift() ?? { data: null, error: null })
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'or', 'gte', 'gt', 'order', 'limit']) builder[method] = (...args: unknown[]) => { db.calls.push({ table, method, args }); return builder }
  builder.maybeSingle = next; builder.single = next
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => next().then(resolve, reject)
  return builder
} }) }))
import { groupOrder, listParcels, stageTracking, supabasePushStore } from '@/lib/dispatch/store'

const did = (table: string, method: string) => db.calls.filter(call => call.table === table && call.method === method)
const solo = { id: 'p1', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders: [{ id: 'r1', parcel_id: 'p1', order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', position: 0, status: 'staged', fulfillment_id: null, error: null, push_started_at: null, finished_at: null }] }
beforeEach(() => { db.queue.length = 0; db.calls.length = 0 })

describe('staging', () => {
  it('rejects a bad number before touching the database', async () => {
    await expect(stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: 'x1-2', by: 'op' })).rejects.toThrow(/6 to 30|letters and digits/)
    expect(db.calls).toEqual([])
  })
  it('creates a parcel and its first order, normalised, with the detected carrier', async () => {
    db.queue.push({ data: null }, { data: { id: 'p1' } }, { error: null }, { error: null })
    await stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: ' x1234 567 ', by: 'op@example.test' })
    expect(did('dispatch_parcels', 'insert')[0].args[0]).toMatchObject({ shop_domain: 'dispatch-test.myshopify.com', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op@example.test' })
    expect(did('dispatch_parcel_orders', 'insert')[0].args[0]).toMatchObject({ parcel_id: 'p1', order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', position: 0 })
    expect(did('events', 'insert')[0].args[0]).toMatchObject({ event: 'dispatch.staged', actor: 'op@example.test' })
  })
  it('deletes a lone, never-pushed parcel when its number is cleared', async () => {
    db.queue.push({ data: { id: 'r1', parcel_id: 'p1', position: 0, status: 'staged' } }, { data: solo }, { error: null })
    await stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: '', by: 'op' })
    expect(did('dispatch_parcels', 'delete')).toHaveLength(1); expect(did('dispatch_parcels', 'update')).toHaveLength(0)
  })
  it('keeps a grouped parcel when its number is cleared', async () => {
    const grouped = { ...solo, orders: [...solo.orders, { ...solo.orders[0], id: 'r2', order_id: 'gid://shopify/Order/2', order_name: 'Qimati2', position: 1 }] }
    db.queue.push({ data: { id: 'r1', parcel_id: 'p1', position: 0, status: 'staged' } }, { data: grouped }, { error: null })
    await stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: '', by: 'op' })
    expect(did('dispatch_parcels', 'delete')).toHaveLength(0)
    expect(did('dispatch_parcels', 'update')[0].args[0]).toMatchObject({ tracking_number: null, carrier: null })
  })
  it('refuses edits while the parcel is being pushed', async () => {
    db.queue.push({ data: { id: 'r1', parcel_id: 'p1', position: 0, status: 'pushing' } }, { data: { ...solo, orders: [{ ...solo.orders[0], status: 'pushing' }] } })
    await expect(stageTracking({ orderId: '1', orderName: 'Qimati1', tracking: 'X7654321', by: 'op' })).rejects.toThrow(/being pushed/)
  })
})
describe('listing', () => {
  it('shows a push interrupted more than two minutes ago as failed, so it can be pushed again', async () => {
    const stuck = { ...solo, orders: [{ ...solo.orders[0], status: 'pushing', push_started_at: '2026-09-21T05:00:00Z' }] }
    const fresh = { ...solo, id: 'p2', orders: [{ ...solo.orders[0], id: 'r2', parcel_id: 'p2', status: 'pushing', push_started_at: new Date().toISOString() }] }
    db.queue.push({ data: [{ parcel_id: 'p1' }, { parcel_id: 'p2' }] }, { data: [stuck, fresh] }, { data: [] })
    const { open } = await listParcels()
    expect(open[0].orders[0]).toMatchObject({ status: 'failed' }); expect(open[0].orders[0].error).toMatch(/interrupted/)
    expect(open[1].orders[0].status).toBe('pushing')
  })
})
describe('grouping and claiming', () => {
  it('refuses to group an order with itself', async () => { await expect(groupOrder({ primaryOrderId: '1', primaryOrderName: 'Qimati1', orderId: '1', orderName: 'Qimati1', by: 'op' })).rejects.toThrow(/itself/) })
  it('claims staged, failed, or a push stuck for two minutes — nothing else', async () => {
    db.queue.push({ data: { id: 'r1' } })
    expect(await supabasePushStore().claim('r1', 'req-1', new Date('2026-09-21T06:02:00.000Z'))).toBe(true)
    expect(did('dispatch_parcel_orders', 'or')[0].args[0]).toBe('status.in.(staged,failed),and(status.eq.pushing,push_started_at.lt."2026-09-21T06:00:00.000Z")')
    db.queue.push({ data: null })
    expect(await supabasePushStore().claim('r1', 'req-2', new Date())).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/dispatch-store.test.ts`
Expected: FAIL — cannot resolve `@/lib/dispatch/store`.

- [ ] **Step 3: Implement**

```ts
// src/lib/dispatch/store.ts
import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { orderGid } from '@/lib/qc/validation'
import { normalizeTracking, resolveCarrier, trackingProblem } from './carrier'
import type { PushStore } from './push'
import type { ParcelRow } from './types'

const ORDER_FIELDS = 'id,parcel_id,order_id,order_name,position,status,fulfillment_id,error,push_started_at,finished_at'
const PARCEL_FIELDS = `id,tracking_number,carrier,carrier_source,staged_by,staged_at,pushed_by,pushed_at,orders:dispatch_parcel_orders(${ORDER_FIELDS})`
export const STALE_PUSH_MS = 120_000
const READ_FAILED = 'Dispatch could not be read. Reload and try again.'
const shop = () => new ShopifyClient().config.storeDomain
const sorted = (parcel: ParcelRow): ParcelRow => ({ ...parcel, orders: [...parcel.orders].sort((a, b) => a.position - b.position) })
function orderName(value: string): string {
  const name = value.trim()
  if (!/^[\w#-]{1,40}$/.test(name)) throw new Error('That order number does not look right. Reload Dispatch.')
  return name
}

async function record(parcelId: string | null, event: string, detail: Record<string, unknown>, by: string): Promise<void> {
  const { error } = await supabaseServer().from('events').insert({ entity_type: 'dispatch_parcel', entity_id: parcelId, event, detail, actor: by })
  if (error) throw new Error('The audit record could not be written.')
}
async function openRowFor(orderId: string): Promise<{ id: string; parcel_id: string; position: number; status: string } | null> {
  const { data, error } = await supabaseServer().from('dispatch_parcel_orders').select('id,parcel_id,position,status').eq('shop_domain', shop()).eq('order_id', orderId).neq('status', 'fulfilled').maybeSingle()
  if (error) throw new Error(READ_FAILED)
  return data
}
async function loadParcel(parcelId: string): Promise<ParcelRow | null> {
  const { data, error } = await supabaseServer().from('dispatch_parcels').select(PARCEL_FIELDS).eq('shop_domain', shop()).eq('id', parcelId).maybeSingle()
  if (error) throw new Error(READ_FAILED)
  return data ? sorted(data as unknown as ParcelRow) : null
}
async function createParcel(order: { id: string; name: string }, fields: { tracking_number: string | null; carrier: string | null; carrier_source: 'auto' | 'manual' }, by: string): Promise<string> {
  const db = supabaseServer()
  const parcel = await db.from('dispatch_parcels').insert({ shop_domain: shop(), ...fields, staged_by: by }).select('id').single()
  if (parcel.error || !parcel.data) throw new Error('The tracking number could not be saved. Try again.')
  const row = await db.from('dispatch_parcel_orders').insert({ parcel_id: parcel.data.id, shop_domain: shop(), order_id: order.id, order_name: order.name, position: 0 })
  if (row.error) {
    await db.from('dispatch_parcels').delete().eq('id', parcel.data.id)
    throw new Error(row.error.code === '23505' ? `${order.name} is already staged in another parcel. Reload Dispatch.` : 'The tracking number could not be saved. Try again.')
  }
  return parcel.data.id
}
const lone = (parcel: ParcelRow) => parcel.orders.length === 1 && !parcel.pushed_at && parcel.orders[0].status === 'staged'
/** View only: a push that died mid-way (Loupe restarted) reads as failed, so the operator can select and push it again. `claim` accepts the same rows. */
const presentStale = (parcel: ParcelRow, now: number): ParcelRow => ({ ...parcel, orders: parcel.orders.map(item => item.status === 'pushing' && item.push_started_at && now - Date.parse(item.push_started_at) > STALE_PUSH_MS
  ? { ...item, status: 'failed' as const, error: 'The last push was interrupted. Push again; Loupe re-checks Shopify first.' } : item) })

/** Open parcels (any order not yet fulfilled, however old) and parcels pushed in the last `days`. */
export async function listParcels(days = 30): Promise<{ open: ParcelRow[]; recent: ParcelRow[] }> {
  const db = supabaseServer()
  const pending = await db.from('dispatch_parcel_orders').select('parcel_id').eq('shop_domain', shop()).neq('status', 'fulfilled').limit(1000)
  if (pending.error) throw new Error(READ_FAILED)
  const openIds = [...new Set((pending.data ?? []).map(item => item.parcel_id as string))]
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const [open, recent] = await Promise.all([
    openIds.length ? db.from('dispatch_parcels').select(PARCEL_FIELDS).in('id', openIds) : Promise.resolve({ data: [], error: null }),
    db.from('dispatch_parcels').select(PARCEL_FIELDS).eq('shop_domain', shop()).gte('pushed_at', since).order('pushed_at', { ascending: false }).limit(300),
  ])
  if (open.error || recent.error) throw new Error(READ_FAILED)
  const now = Date.now()
  return { open: (open.data as unknown as ParcelRow[]).map(parcel => presentStale(sorted(parcel), now)), recent: (recent.data as unknown as ParcelRow[]).map(sorted) }
}

export interface StageInput { orderId: string; orderName: string; tracking: string; carrier?: string; by: string }
/** Saves the number (and carrier) typed against an order. The edit applies to the order's whole parcel. */
export async function stageTracking(input: StageInput): Promise<void> {
  const tracking = normalizeTracking(input.tracking)
  if (tracking) { const problem = trackingProblem(tracking); if (problem) throw new Error(problem) }
  const order = { id: orderGid(input.orderId), name: orderName(input.orderName) }
  const row = await openRowFor(order.id)
  const parcel = row ? await loadParcel(row.parcel_id) : null
  if (parcel?.orders.some(item => item.status === 'pushing')) throw new Error('This parcel is being pushed. Wait for it to finish.')
  const next = resolveCarrier(parcel ? { carrier: parcel.carrier, source: parcel.carrier_source } : null, tracking, input.carrier)
  const fields = { tracking_number: tracking || null, carrier: next.carrier, carrier_source: next.source }
  const db = supabaseServer()
  let parcelId = parcel?.id ?? null
  if (!parcel) {
    if (!tracking && next.source === 'auto') return
    parcelId = await createParcel(order, fields, input.by)
  } else if (!tracking && next.source === 'auto' && lone(parcel)) {
    const gone = await db.from('dispatch_parcels').delete().eq('id', parcel.id)
    if (gone.error) throw new Error('The tracking number could not be cleared. Try again.')
    return
  } else {
    const saved = await db.from('dispatch_parcels').update(fields).eq('id', parcel.id)
    if (saved.error) throw new Error('The tracking number could not be saved. Try again.')
  }
  if (tracking) await record(parcelId, 'dispatch.staged', { order: order.name, tracking, carrier: next.carrier, carrier_source: next.source }, input.by)
}

export interface GroupInput { primaryOrderId: string; primaryOrderName: string; orderId: string; orderName: string; by: string }
/** Adds `orderId` to the parcel of `primaryOrderId`, creating that parcel (without a number yet) when needed. */
export async function groupOrder(input: GroupInput): Promise<void> {
  const primary = { id: orderGid(input.primaryOrderId), name: orderName(input.primaryOrderName) }
  const child = { id: orderGid(input.orderId), name: orderName(input.orderName) }
  if (primary.id === child.id) throw new Error('An order cannot be grouped with itself.')
  const db = supabaseServer()
  const primaryRow = await openRowFor(primary.id)
  const parcelId = primaryRow?.parcel_id ?? await createParcel(primary, { tracking_number: null, carrier: null, carrier_source: 'auto' }, input.by)
  const parcel = await loadParcel(parcelId)
  if (!parcel) throw new Error(READ_FAILED)
  if (parcel.orders.some(item => item.status === 'pushing')) throw new Error('This parcel is being pushed. Wait for it to finish.')
  const childRow = await openRowFor(child.id)
  if (childRow?.parcel_id === parcelId) return
  if (childRow) {
    const other = await loadParcel(childRow.parcel_id)
    if (!other || !lone(other)) throw new Error(`${child.name} is already in another parcel. Remove it there first.`)
    const gone = await db.from('dispatch_parcels').delete().eq('id', other.id)
    if (gone.error) throw new Error(`${child.name} could not be moved. Try again.`)
  }
  const position = Math.max(...parcel.orders.map(item => item.position)) + 1
  const added = await db.from('dispatch_parcel_orders').insert({ parcel_id: parcelId, shop_domain: shop(), order_id: child.id, order_name: child.name, position })
  if (added.error) throw new Error(added.error.code === '23505' ? `${child.name} was just added elsewhere. Reload Dispatch.` : `${child.name} could not be added. Try again.`)
  await record(parcelId, 'dispatch.grouped', { parcel_of: primary.name, added: child.name }, input.by)
}

/** Removes an added order that has not been fulfilled; it returns to the main list. */
export async function ungroupOrder(input: { orderId: string; by: string }): Promise<void> {
  const row = await openRowFor(orderGid(input.orderId))
  if (!row || row.position === 0) throw new Error('Only an added order can be removed from a parcel.')
  if (row.status === 'pushing') throw new Error('This order is being pushed. Wait for it to finish.')
  const gone = await supabaseServer().from('dispatch_parcel_orders').delete().eq('id', row.id).in('status', ['staged', 'failed'])
  if (gone.error) throw new Error('The order could not be removed. Try again.')
  await record(row.parcel_id, 'dispatch.ungrouped', { order_id: input.orderId }, input.by)
}

/** Drops staged work for orders that left the list. History (a fulfilled order) is never deleted. */
export async function discardParcel(input: { parcelId: string; by: string }): Promise<void> {
  const parcel = await loadParcel(input.parcelId)
  if (!parcel) return
  if (parcel.orders.some(item => item.status === 'pushing')) throw new Error('This parcel is being pushed. Wait for it to finish.')
  const db = supabaseServer()
  const gone = parcel.orders.some(item => item.status === 'fulfilled')
    ? await db.from('dispatch_parcel_orders').delete().eq('parcel_id', parcel.id).in('status', ['staged', 'failed'])
    : await db.from('dispatch_parcels').delete().eq('id', parcel.id)
  if (gone.error) throw new Error('The parcel could not be discarded. Try again.')
  await record(parcel.id, 'dispatch.discarded', { orders: parcel.orders.filter(item => item.status !== 'fulfilled').map(item => item.order_name) }, input.by)
}

export function supabasePushStore(): PushStore {
  const db = supabaseServer()
  return {
    loadParcel, record,
    async claim(rowId, requestId, now) {
      const stale = new Date(now.getTime() - STALE_PUSH_MS).toISOString()
      const { data, error } = await db.from('dispatch_parcel_orders').update({ status: 'pushing', request_id: requestId, push_started_at: now.toISOString(), error: null })
        .eq('id', rowId).or(`status.in.(staged,failed),and(status.eq.pushing,push_started_at.lt."${stale}")`).select('id').maybeSingle()
      if (error) throw new Error('The push could not be started. Try again.')
      return !!data
    },
    async fail(rowId, message) {
      const { error } = await db.from('dispatch_parcel_orders').update({ status: 'failed', error: message.slice(0, 500) }).eq('id', rowId).in('status', ['staged', 'failed'])
      if (error) throw new Error('The refusal could not be saved. Reload Dispatch.')
    },
    async finish(rowId, requestId, result, now) {
      const values = 'fulfillmentId' in result ? { status: 'fulfilled', fulfillment_id: result.fulfillmentId, error: null } : { status: 'failed', error: result.error.slice(0, 500) }
      const { error } = await db.from('dispatch_parcel_orders').update({ ...values, finished_at: now.toISOString() }).eq('id', rowId).eq('request_id', requestId)
      if (error) throw new Error('The push result could not be saved. Reload Dispatch; the Shopify order is the truth.')
    },
    async markPushed(parcelId, by, now) {
      const { error } = await db.from('dispatch_parcels').update({ pushed_by: by, pushed_at: now.toISOString() }).eq('id', parcelId)
      if (error) throw new Error('The push time could not be saved.')
    },
  }
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/dispatch-store.test.ts && npm run typecheck`
Expected: 8 tests PASS. If typecheck complains that the Supabase builder is not assignable where `Promise.resolve({ data: [], error: null })` is used, annotate that branch as `{ data: unknown[]; error: null }`; do not change behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dispatch/store.ts tests/dispatch-store.test.ts
git commit -m "feat(dispatch): Supabase store — stage, group, discard, 30-day history, single-claim push rows"
```


---

### Task 7: Server actions

**Files:**
- Create: `src/app/(shell)/dispatch/actions.ts`
- Test: `tests/dispatch-actions.test.ts`

**Interfaces:**
- Consumes: `requireOperatorForAction()`, `actorFor(operator)` from `@/lib/auth/authorize`; Task 3, 5, 6 exports.
- Produces: `DispatchState = { ok: boolean; message: string }`; `stageTrackingAction(input: { orderId: string; orderName: string; tracking: string; carrier?: string }): Promise<DispatchState>`; `groupOrderAction(input: { primaryOrderId: string; primaryOrderName: string; orderId: string; orderName: string }): Promise<DispatchState>`; `ungroupOrderAction(orderId: string): Promise<DispatchState>`; `discardParcelAction(parcelId: string): Promise<DispatchState>`; `pushParcelAction(parcelId: string): Promise<DispatchState & { results: PushResult[] }>`.

The screen pushes parcels one action call at a time, so a long push never outlives a proxy timeout and each parcel's result appears as it finishes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dispatch-actions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ operator: vi.fn(), stage: vi.fn(), push: vi.fn(), clientOptions: [] as unknown[] }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorForAction: mocks.operator, actorFor: (operator: { email: string }) => operator.email }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { tokens = 'shared-tokens'; constructor(options: unknown) { mocks.clientOptions.push(options) } } }))
vi.mock('@/lib/shopify/dispatch-orders', () => ({ readDispatchOrder: vi.fn(), createFulfillment: vi.fn(), dispatchShopifyError: (cause: unknown) => (cause instanceof Error ? cause.message : 'x') }))
vi.mock('@/lib/dispatch/store', () => ({ stageTracking: mocks.stage, groupOrder: vi.fn(), ungroupOrder: vi.fn(), discardParcel: vi.fn(), supabasePushStore: () => ({}) }))
vi.mock('@/lib/dispatch/push', () => ({ pushParcel: mocks.push }))
import { pushParcelAction, stageTrackingAction } from '@/app/(shell)/dispatch/actions'

beforeEach(() => { vi.clearAllMocks(); mocks.clientOptions.length = 0; mocks.operator.mockResolvedValue({ id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'admin' }) })

describe('dispatch actions', () => {
  it('takes the actor from the session, never from the browser', async () => {
    mocks.stage.mockResolvedValue(undefined)
    expect(await stageTrackingAction({ orderId: '1', orderName: 'Qimati1', tracking: 'X1234567', by: 'forged@example.test' } as never)).toEqual({ ok: true, message: 'Saved.' })
    expect(mocks.stage).toHaveBeenCalledWith({ orderId: '1', orderName: 'Qimati1', tracking: 'X1234567', carrier: undefined, by: 'owner@example.test' })
  })
  it('returns the refusal as a sentence', async () => {
    mocks.stage.mockRejectedValue(new Error('A tracking number is 6 to 30 characters.'))
    expect(await stageTrackingAction({ orderId: '1', orderName: 'Qimati1', tracking: 'X1' })).toEqual({ ok: false, message: 'A tracking number is 6 to 30 characters.' })
  })
  it('refuses when nobody is signed in, before any work', async () => {
    mocks.operator.mockRejectedValue(new Error('Sign in again.'))
    expect((await pushParcelAction('3f0c5a0e-6d0b-4a53-9d2e-0a4a3b1f7c11')).ok).toBe(false); expect(mocks.push).not.toHaveBeenCalled()
  })
  it('pushes with a single-attempt writer that shares the reader\'s token manager', async () => {
    mocks.push.mockResolvedValue([{ orderId: 'gid://shopify/Order/1', orderName: 'Qimati1', status: 'fulfilled', message: 'Fulfilled with DTDC X1234567.' }])
    const outcome = await pushParcelAction('3f0c5a0e-6d0b-4a53-9d2e-0a4a3b1f7c11')
    expect(outcome).toMatchObject({ ok: true, message: '1 order fulfilled.' })
    expect(mocks.clientOptions).toEqual([undefined, { retryDelaysMs: [0], tokens: 'shared-tokens' }])
    expect(mocks.push.mock.calls[0].slice(0, 2)).toEqual(['3f0c5a0e-6d0b-4a53-9d2e-0a4a3b1f7c11', 'owner@example.test'])
  })
  it('rejects a parcel id that is not a uuid', async () => { expect((await pushParcelAction('1; drop table')).ok).toBe(false); expect(mocks.push).not.toHaveBeenCalled() })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/dispatch-actions.test.ts`
Expected: FAIL — cannot resolve `@/app/(shell)/dispatch/actions`.

- [ ] **Step 3: Implement**

```ts
// src/app/(shell)/dispatch/actions.ts
'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { actorFor, requireOperatorForAction } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { createFulfillment, dispatchShopifyError, readDispatchOrder } from '@/lib/shopify/dispatch-orders'
import { pushParcel, type PushResult } from '@/lib/dispatch/push'
import { discardParcel, groupOrder, stageTracking, supabasePushStore, ungroupOrder } from '@/lib/dispatch/store'

export interface DispatchState { readonly ok: boolean; readonly message: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Runs one change as the signed-in operator. The actor always comes from the session, never from the browser. */
async function run(work: (by: string) => Promise<string>): Promise<DispatchState> {
  try {
    const by = actorFor(await requireOperatorForAction())
    const message = await work(by)
    revalidatePath('/dispatch')
    return { ok: true, message }
  } catch (cause) { return { ok: false, message: dispatchShopifyError(cause) } }
}

export async function stageTrackingAction(input: { orderId: string; orderName: string; tracking: string; carrier?: string }): Promise<DispatchState> {
  return run(async by => { await stageTracking({ orderId: String(input.orderId), orderName: String(input.orderName), tracking: String(input.tracking ?? ''), carrier: input.carrier === undefined ? undefined : String(input.carrier), by }); return 'Saved.' })
}
export async function groupOrderAction(input: { primaryOrderId: string; primaryOrderName: string; orderId: string; orderName: string }): Promise<DispatchState> {
  return run(async by => { await groupOrder({ primaryOrderId: String(input.primaryOrderId), primaryOrderName: String(input.primaryOrderName), orderId: String(input.orderId), orderName: String(input.orderName), by }); return 'Added to the parcel.' })
}
export async function ungroupOrderAction(orderId: string): Promise<DispatchState> {
  return run(async by => { await ungroupOrder({ orderId: String(orderId), by }); return 'Removed from the parcel.' })
}
export async function discardParcelAction(parcelId: string): Promise<DispatchState> {
  return run(async by => { if (!UUID.test(String(parcelId))) throw new Error('Reload Dispatch and try again.'); await discardParcel({ parcelId, by }); return 'Discarded.' })
}

/** One parcel per call. Reads retry as usual; the fulfilment mutation is sent exactly once. */
export async function pushParcelAction(parcelId: string): Promise<DispatchState & { results: PushResult[] }> {
  let results: PushResult[] = []
  const state = await run(async by => {
    if (!UUID.test(String(parcelId))) throw new Error('Reload Dispatch and try again.')
    const reader = new ShopifyClient()
    const writer = new ShopifyClient({ retryDelaysMs: [0], tokens: reader.tokens })
    results = await pushParcel(parcelId, by, { store: supabasePushStore(), readOrder: id => readDispatchOrder(reader, id), fulfil: input => createFulfillment(writer, input), now: () => new Date(), newId: randomUUID })
    const fulfilled = results.filter(result => result.status === 'fulfilled').length
    return fulfilled === results.length ? `${fulfilled} order${fulfilled === 1 ? '' : 's'} fulfilled.` : `${fulfilled} of ${results.length} orders fulfilled. See each row.`
  })
  return { ...state, results }
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/dispatch-actions.test.ts && npm run typecheck`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(shell)/dispatch/actions.ts" tests/dispatch-actions.test.ts
git commit -m "feat(dispatch): server actions — session actor, one parcel per push call, single-attempt mutation client"
```

---

Continue with `2026-09-21-dispatch-tracking-5-screen-rollout.md`.
