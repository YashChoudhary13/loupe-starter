import type { DispatchOrderSummary, ParcelOrderStatus, ParcelRow } from './types'

export interface DispatchChild { orderId: string; orderName: string; listed: boolean; qcPassed: boolean; differentAddress: boolean; status: ParcelOrderStatus; error: string | null }
export interface DispatchRowModel { order: DispatchOrderSummary; listed: boolean; qcPassed: boolean; parcel: ParcelRow | null; status: ParcelOrderStatus | null; error: string | null; children: DispatchChild[] }

/** One row per parcel (its first unfulfilled order) plus one per listed order not yet in a parcel; newest order first. */
export function buildRows(orders: readonly DispatchOrderSummary[], qcPassed: Readonly<Record<string, boolean>>, open: readonly ParcelRow[]): DispatchRowModel[] {
  const byId = new Map(orders.map(order => [order.id, order]))
  const placed = new Set<string>()
  const rows: DispatchRowModel[] = []
  for (const parcel of open) {
    const pending = parcel.orders.filter(item => item.status !== 'fulfilled').sort((a, b) => a.position - b.position)
    if (pending.length === 0) continue
    const [first, ...rest] = pending
    const order = byId.get(first.order_id) ?? { id: first.order_id, name: first.order_name, createdAt: parcel.staged_at, customer: '—', addressKey: '' }
    rows.push({
      order, listed: byId.has(first.order_id), qcPassed: !!qcPassed[first.order_id], parcel, status: first.status, error: first.error,
      children: rest.map(item => {
        const child = byId.get(item.order_id)
        return { orderId: item.order_id, orderName: item.order_name, listed: !!child, qcPassed: !!qcPassed[item.order_id], differentAddress: !!child && !!order.addressKey && child.addressKey !== order.addressKey, status: item.status, error: item.error }
      }),
    })
    for (const item of pending) placed.add(item.order_id)
  }
  for (const order of orders) if (!placed.has(order.id)) rows.push({ order, listed: true, qcPassed: !!qcPassed[order.id], parcel: null, status: null, error: null, children: [] })
  return rows.sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt))
}

/** Ready to push: the parcel has both a number and a carrier. */
export function isStaged(row: DispatchRowModel): boolean { return !!row.parcel?.tracking_number && !!row.parcel.carrier }

/** Once any order of a parcel has been pushed, its number is what a customer was told: it can no longer be
 * edited, only discarded. The remaining order may still be pushed again with that same number. */
export function parcelFrozen(parcel: ParcelRow | null): boolean { return !!parcel?.pushed_at }

export function duplicateTracking(rows: readonly DispatchRowModel[]): Map<string, string[]> {
  const names = new Map<string, string[]>()
  for (const row of rows) { const number = row.parcel?.tracking_number; if (number) names.set(number, [...(names.get(number) ?? []), row.order.name]) }
  return new Map([...names].filter(([, list]) => list.length > 1))
}

/** A field is disabled only while its own row is being pushed, or while a push is running screen-wide;
 * a save, group, ungroup or discard in flight never locks a field, so scanner focus survives it. */
export function rowLocked(status: ParcelOrderStatus | null, pushRunning: boolean): boolean {
  return status === 'pushing' || pushRunning
}

/** The one irreversible action must never race an in-flight save: disabled unless something is chosen,
 * no push is already running, and every save has settled — so the confirm sheet always shows the number
 * that will actually be sent. */
export function canPush(chosen: number, pushRunning: boolean, saving: number): boolean {
  return chosen > 0 && !pushRunning && saving === 0
}
