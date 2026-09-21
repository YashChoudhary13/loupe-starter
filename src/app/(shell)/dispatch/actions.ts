'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { actorFor, requireOperatorForAction } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { createFulfillment, dispatchShopifyError, readDispatchOrder } from '@/lib/shopify/dispatch-orders'
import { pushParcel, type PushExpectation, type PushResult } from '@/lib/dispatch/push'
import { discardParcel, groupOrder, stageTracking, supabasePushStore, ungroupOrder } from '@/lib/dispatch/store'

export interface DispatchState { readonly ok: boolean; readonly message: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9]\d{0,22}$/

/** The browser's copy of what the confirm sheet showed. Only its shape is trusted here; `pushParcel` decides whether it still matches the row. */
function confirmed(input: unknown): PushExpectation {
  const value = (input ?? {}) as Partial<Record<keyof PushExpectation, unknown>>
  const orderIds = Array.isArray(value.orderIds) ? value.orderIds : []
  if (typeof value.carrier !== 'string' || typeof value.tracking !== 'string' || orderIds.length < 1 || orderIds.length > 50 || orderIds.some(id => typeof id !== 'string' || !ORDER_GID.test(id))) throw new Error('Reload Dispatch and try again.')
  return { carrier: value.carrier, tracking: value.tracking, orderIds: orderIds as string[] }
}

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

/** One parcel per call, pushed only if it still matches what the owner confirmed. Reads retry as usual; the fulfilment mutation is sent exactly once. */
export async function pushParcelAction(parcelId: string, expected: PushExpectation): Promise<DispatchState & { results: PushResult[] }> {
  let results: PushResult[] = []
  const state = await run(async by => {
    if (!UUID.test(String(parcelId))) throw new Error('Reload Dispatch and try again.')
    const reader = new ShopifyClient()
    // 60 s, because undici's default of 300 s outlives the 120 s stale-claim takeover: a hung mutation could
    // otherwise still be in flight when a second push claims the row. An abort is an ordinary failure here —
    // the re-read, not the response, decides whether the fulfilment landed.
    const writer = new ShopifyClient({ retryDelaysMs: [0], tokens: reader.tokens, fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }) })
    results = await pushParcel(parcelId, by, { store: supabasePushStore(), readOrder: id => readDispatchOrder(reader, id), fulfil: input => createFulfillment(writer, input), now: () => new Date(), newId: randomUUID }, confirmed(expected))
    const fulfilled = results.filter(result => result.status === 'fulfilled').length
    return fulfilled === results.length ? `${fulfilled} order${fulfilled === 1 ? '' : 's'} fulfilled.` : `${fulfilled} of ${results.length} orders fulfilled. See each row.`
  })
  return { ...state, results }
}
