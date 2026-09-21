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
/** A pushed parcel's number is what a customer was told, so it is frozen: only a discard clears what is left. */
const frozen = (parcel: ParcelRow) => `Part of this parcel was already pushed with ${parcel.carrier} ${parcel.tracking_number}, so its number can no longer change. Discard the remaining order and stage it again.`
/** Deletes the parcel only once no order row references it any more — called after a conditional order-row delete. */
async function deleteParcelIfEmpty(db: ReturnType<typeof supabaseServer>, parcelId: string, failMessage: string): Promise<void> {
  const remaining = await db.from('dispatch_parcel_orders').select('id').eq('parcel_id', parcelId).limit(1)
  if (remaining.error) throw new Error(READ_FAILED)
  if (remaining.data?.length) return
  const gone = await db.from('dispatch_parcels').delete().eq('id', parcelId)
  if (gone.error) throw new Error(failMessage)
}
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
    openIds.length ? db.from('dispatch_parcels').select(PARCEL_FIELDS).in('id', openIds) : Promise.resolve({ data: [] as unknown[], error: null }),
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
  if (parcel?.pushed_at) throw new Error(frozen(parcel))
  const next = resolveCarrier(parcel ? { carrier: parcel.carrier, source: parcel.carrier_source } : null, tracking, input.carrier)
  const fields = { tracking_number: tracking || null, carrier: next.carrier, carrier_source: next.source }
  const db = supabaseServer()
  let parcelId = parcel?.id ?? null
  if (!parcel) {
    if (!tracking && next.source === 'auto') return
    parcelId = await createParcel(order, fields, input.by)
  } else if (!tracking && next.source === 'auto' && lone(parcel)) {
    const openOrder = parcel.orders[0]
    const gone = await db.from('dispatch_parcel_orders').delete().eq('id', openOrder.id).in('status', ['staged', 'failed']).select('id')
    if (gone.error) throw new Error('The tracking number could not be cleared. Try again.')
    if (!gone.data?.length) throw new Error('This parcel is being pushed. Wait for it to finish.')
    await deleteParcelIfEmpty(db, parcel.id, 'The tracking number could not be cleared. Try again.')
    if (parcel.tracking_number) await record(parcel.id, 'dispatch.unstaged', { order: order.name, tracking: parcel.tracking_number }, input.by)
    return
  } else {
    // ponytail: read-then-act. An edit racing a push can still be accepted and is then superseded by the number markPushed re-asserts at the end of that push; its dispatch.staged event is the trace. Upgrade path: a pushing_since lock column on dispatch_parcels set by one conditional update, if such an edit should be refused outright.
    const saved = await db.from('dispatch_parcels').update(fields).eq('id', parcel.id).is('pushed_at', null).select('id')
    if (saved.error) throw new Error('The tracking number could not be saved. Try again.')
    if (!saved.data?.length) throw new Error(frozen(parcel))
    if (!tracking && parcel.tracking_number) await record(parcel.id, 'dispatch.unstaged', { order: order.name, tracking: parcel.tracking_number }, input.by)
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
  if (parcel.pushed_at) throw new Error('That parcel was already pushed. Stage this order on its own.')
  const childRow = await openRowFor(child.id)
  if (childRow?.parcel_id === parcelId) return
  let absorbed: { parcelId: string; tracking: string | null } | null = null
  if (childRow) {
    const other = await loadParcel(childRow.parcel_id)
    if (!other || !lone(other)) throw new Error(`${child.name} is already in another parcel. Remove it there first.`)
    const gone = await db.from('dispatch_parcel_orders').delete().eq('id', other.orders[0].id).in('status', ['staged', 'failed']).select('id')
    if (gone.error) throw new Error(`${child.name} could not be moved. Try again.`)
    if (!gone.data?.length) throw new Error(`${child.name} is being pushed. Wait for it to finish.`)
    await deleteParcelIfEmpty(db, other.id, `${child.name} could not be moved. Try again.`)
    absorbed = { parcelId: other.id, tracking: other.tracking_number }
  }
  const position = Math.max(...parcel.orders.map(item => item.position)) + 1
  const added = await db.from('dispatch_parcel_orders').insert({ parcel_id: parcelId, shop_domain: shop(), order_id: child.id, order_name: child.name, position })
  if (added.error) {
    if (absorbed?.tracking) await record(absorbed.parcelId, 'dispatch.unstaged', { order: child.name, tracking: absorbed.tracking }, input.by)
    throw new Error(added.error.code === '23505' ? `${child.name} was just added elsewhere. Reload Dispatch.` : `${child.name} could not be added. Try again.`)
  }
  await record(parcelId, 'dispatch.grouped', { parcel_of: primary.name, added: child.name, absorbed_tracking: absorbed?.tracking ?? null }, input.by)
}

/** Removes an added order that has not been fulfilled; it returns to the main list. */
export async function ungroupOrder(input: { orderId: string; by: string }): Promise<void> {
  const row = await openRowFor(orderGid(input.orderId))
  if (!row || row.position === 0) throw new Error('Only an added order can be removed from a parcel.')
  if (row.status === 'pushing') throw new Error('This order is being pushed. Wait for it to finish.')
  const gone = await supabaseServer().from('dispatch_parcel_orders').delete().eq('id', row.id).in('status', ['staged', 'failed']).select('id')
  if (gone.error) throw new Error('The order could not be removed. Try again.')
  if (!gone.data?.length) throw new Error('This order is being pushed. Wait for it to finish.')
  await record(row.parcel_id, 'dispatch.ungrouped', { order_id: input.orderId }, input.by)
}

/** Drops staged work for orders that left the list. History (a fulfilled order) is never deleted. */
export async function discardParcel(input: { parcelId: string; by: string }): Promise<void> {
  const parcel = await loadParcel(input.parcelId)
  if (!parcel) return
  if (parcel.orders.some(item => item.status === 'pushing')) throw new Error('This parcel is being pushed. Wait for it to finish.')
  const db = supabaseServer()
  const open = parcel.orders.filter(item => item.status !== 'fulfilled')
  if (open.length) {
    const gone = await db.from('dispatch_parcel_orders').delete().eq('parcel_id', parcel.id).in('status', ['staged', 'failed']).select('id')
    if (gone.error) throw new Error('The parcel could not be discarded. Try again.')
    if (!gone.data?.length) throw new Error('This parcel is being pushed. Wait for it to finish.')
  }
  await deleteParcelIfEmpty(db, parcel.id, 'The parcel could not be discarded. Try again.')
  await record(parcel.id, 'dispatch.discarded', { orders: open.map(item => item.order_name) }, input.by)
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
    async markPushed(parcelId, by, now, sent) {
      // Re-asserts what was actually sent, so an edit that raced this push is superseded rather than left as history.
      const { error } = await db.from('dispatch_parcels').update({ tracking_number: sent.number, carrier: sent.carrier, pushed_by: by, pushed_at: now.toISOString() }).eq('id', parcelId)
      if (error) throw new Error('The push time could not be saved.')
    },
  }
}
