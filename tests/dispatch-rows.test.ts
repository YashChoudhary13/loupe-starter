import { describe, expect, it } from 'vitest'
import { buildRows, canPush, duplicateTracking, isStaged, parcelFrozen, rowLocked } from '@/lib/dispatch/rows'
import type { DispatchOrderSummary, ParcelOrderRow, ParcelRow } from '@/lib/dispatch/types'

const order = (n: number, addressKey = 'aaaa'): DispatchOrderSummary => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: `2026-09-2${n}T05:00:00Z`, customer: `Customer ${n}`, addressKey })
const item = (n: number, position: number, status: ParcelOrderRow['status'] = 'staged'): ParcelOrderRow => ({ id: `r${n}`, parcel_id: 'p', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position, status, fulfillment_id: status === 'fulfilled' ? 'f' : null, error: null, push_started_at: null, finished_at: null })
const parcel = (id: string, orders: ParcelOrderRow[], tracking: string | null = 'X1234567'): ParcelRow => ({ id, tracking_number: tracking, carrier: tracking ? 'DTDC' : null, carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders })

describe('dispatch rows', () => {
  it('nests added orders under their parcel and removes them from the main list', () => {
    const rows = buildRows([order(1), order(2, 'bbbb'), order(3)], { 'gid://shopify/Order/2': true }, [parcel('p1', [item(1, 0), item(2, 1)])])
    expect(rows.map(row => row.order.name)).toEqual(['Qimati3', 'Qimati1'])
    expect(rows[1].children).toEqual([{ orderId: 'gid://shopify/Order/2', orderName: 'Qimati2', listed: true, qcPassed: true, differentAddress: true, status: 'staged', error: null }])
    expect(isStaged(rows[1])).toBe(true); expect(isStaged(rows[0])).toBe(false)
  })
  it('promotes the next order when the first of a parcel is already fulfilled', () => {
    const rows = buildRows([order(2)], {}, [parcel('p1', [item(1, 0, 'fulfilled'), item(2, 1, 'failed')])])
    expect(rows).toHaveLength(1); expect(rows[0].order.name).toBe('Qimati2'); expect(rows[0].children).toEqual([])
  })
  it('keeps staged work visible when its order left the Shopify list', () => {
    const [row] = buildRows([], {}, [parcel('p1', [item(9, 0)])])
    expect(row).toMatchObject({ listed: false, order: { name: 'Qimati9', customer: '—' } })
  })
  it('does not call a parcel staged without a number', () => { expect(isStaged(buildRows([order(1)], {}, [parcel('p1', [item(1, 0)], null)])[0])).toBe(false) })
  it('reports a number used by two parcels, and only that', () => {
    const rows = buildRows([order(1), order(2), order(3)], {}, [parcel('p1', [item(1, 0)]), parcel('p2', [{ ...item(2, 0), parcel_id: 'p2' }]), parcel('p3', [{ ...item(3, 0), parcel_id: 'p3' }], 'X7654321')])
    expect([...duplicateTracking(rows)]).toEqual([['X1234567', ['Qimati2', 'Qimati1']]])
  })
  it('locks a row only while it is pushing, or while a push is running screen-wide', () => {
    expect(rowLocked('staged', false)).toBe(false)
    expect(rowLocked('failed', false)).toBe(false)
    expect(rowLocked(null, false)).toBe(false)
    expect(rowLocked('pushing', false)).toBe(true)
    expect(rowLocked('staged', true)).toBe(true)
    expect(rowLocked(null, true)).toBe(true)
  })
  it('freezes a parcel once any part of it has been pushed', () => {
    expect(parcelFrozen(null)).toBe(false)
    expect(parcelFrozen(parcel('p1', [item(1, 0)]))).toBe(false)
    expect(parcelFrozen({ ...parcel('p1', [item(1, 0, 'fulfilled'), item(2, 1, 'failed')]), pushed_by: 'owner@example.test', pushed_at: '2026-09-21T06:00:00Z' })).toBe(true)
  })
  it('allows Push only when something is chosen, no push is already running, and every save has settled', () => {
    expect(canPush(0, false, 0)).toBe(false)
    expect(canPush(1, false, 0)).toBe(true)
    expect(canPush(1, true, 0)).toBe(false)
    expect(canPush(1, false, 1)).toBe(false)
    expect(canPush(0, true, 1)).toBe(false)
    expect(canPush(2, false, 0)).toBe(true)
  })
})
