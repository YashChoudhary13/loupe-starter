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
  /** Records who pushed and when, and re-asserts the carrier and number actually sent, so an edit that raced this push cannot survive as the parcel's history. */
  markPushed(parcelId: string, by: string, now: Date, sent: { carrier: Carrier; number: string }): Promise<void>
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
/** Exactly what the owner saw on the confirm sheet. Another device can change a parcel after the owner's last
 * refresh, so this travels with the push and is checked against the row before anything is read from Shopify. */
export interface PushExpectation { carrier: string; tracking: string; orderIds: string[] }

const CHECK = 'Check the order in Shopify, then push again.'
const CHANGED = 'This parcel changed on another screen. Reload Dispatch and check it before pushing.'

export async function pushParcel(parcelId: string, by: string, deps: PushDeps, expected: PushExpectation): Promise<PushResult[]> {
  const parcel = await deps.store.loadParcel(parcelId)
  if (!parcel) throw new Error('This parcel no longer exists. Reload Dispatch.')
  const pending = parcel.orders.filter(item => item.status !== 'fulfilled').sort((a, b) => a.position - b.position)
  const confirmed = new Set(expected.orderIds)
  if (parcel.tracking_number !== expected.tracking || parcel.carrier !== expected.carrier || pending.length !== confirmed.size || pending.some(item => !confirmed.has(item.order_id))) throw new Error(CHANGED)
  if (!parcel.tracking_number || !parcel.carrier) throw new Error('Add a tracking number and carrier before pushing.')
  const number = parcel.tracking_number, carrier = parcel.carrier
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
      if (plan.kind === 'refuse') await guard('dispatch fail write failed', () => deps.store.fail(item.id, message))
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
    // A claim that throws is the one store call before anything is sent, so saying nothing went out is true —
    // and skipping to the next order keeps an earlier order's fulfilment, markPushed and audit event.
    let claimed: boolean
    try { claimed = await deps.store.claim(item.id, requestId, deps.now()) }
    catch (cause) { console.error('dispatch claim failed', cause); results.push({ orderId: item.order_id, orderName: item.order_name, status: 'failed', message: 'Loupe could not start this order, so nothing was sent for it. Push again.' }); continue }
    if (!claimed) { results.push({ orderId: item.order_id, orderName: item.order_name, status: 'busy', message: 'Another push is handling this order.' }); continue }
    let fulfillmentId = plan.kind === 'done' ? plan.fulfillmentId : null
    let failure: string | null = null
    if (plan.kind === 'fulfil') {
      try { await deps.fulfil({ fulfillmentOrderIds: plan.fulfillmentOrderIds, company: carrier, number }) }
      catch (cause) { failure = cause instanceof Error ? cause.message : 'Shopify did not answer.' }
      try { fulfillmentId = confirmsPush(await deps.readOrder(item.order_id), carrier, number) }
      catch { failure ??= 'Shopify could not be re-read after the push.' }
    }
    if (fulfillmentId) {
      const saved = await guard('dispatch finish write failed', () => deps.store.finish(item.id, requestId, { fulfillmentId }, deps.now()))
      results.push({ orderId: item.order_id, orderName: item.order_name, status: 'fulfilled', message: saved ? `Fulfilled with ${carrier} ${number}.` : `Fulfilled with ${carrier} ${number}, but Loupe could not save the result. Reload Dispatch; the Shopify order is the truth.` })
    } else {
      const message = failure ? `${failure} ${CHECK}` : `Shopify did not confirm the fulfilment. ${CHECK}`
      await guard('dispatch finish write failed', () => deps.store.finish(item.id, requestId, { error: message }, deps.now()))
      results.push({ orderId: item.order_id, orderName: item.order_name, status: 'failed', message })
    }
  }
  if (results.some(result => result.status === 'fulfilled')) await guard('dispatch markPushed write failed', () => deps.store.markPushed(parcelId, by, deps.now(), { carrier, number }))
  await audit(deps, parcelId, results.every(result => result.status === 'fulfilled') ? 'dispatch.pushed' : 'dispatch.failed', { tracking: number, carrier, orders: results.map(result => ({ order: result.orderName, status: result.status })) }, by)
  return results
}

/** The fulfilment already happened; a failed audit write must not turn the result into an error. */
async function audit(deps: PushDeps, parcelId: string, event: string, detail: Record<string, unknown>, by: string): Promise<void> {
  try { await deps.store.record(parcelId, event, detail, by) } catch (cause) { console.error('dispatch audit write failed', event, cause) }
}

/** The Shopify outcome is already known; a Loupe write recording it must not turn a known result into a thrown error. */
async function guard(label: string, action: () => Promise<void>): Promise<boolean> {
  try { await action(); return true } catch (cause) { console.error(label, cause); return false }
}
