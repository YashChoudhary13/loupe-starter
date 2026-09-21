import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('@/app/(shell)/dispatch/actions', () => ({ stageTrackingAction: vi.fn(), groupOrderAction: vi.fn(), ungroupOrderAction: vi.fn(), discardParcelAction: vi.fn(), pushParcelAction: vi.fn() }))
import { DispatchScreen, type DispatchScreenProps } from '@/components/dispatch/DispatchScreen'

const order = (n: number) => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: `2026-09-2${n}T05:00:00Z`, customer: `Customer ${n}`, addressKey: 'aaaa' })
const item = (n: number, position: number, status = 'staged') => ({ id: `r${n}`, parcel_id: 'p1', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position, status, fulfillment_id: status === 'fulfilled' ? 'f1' : null, error: null, push_started_at: null, finished_at: null })
const props = (changes: Partial<DispatchScreenProps> = {}): DispatchScreenProps => ({
  orders: [order(1), order(2), order(3)], qcPassed: { 'gid://shopify/Order/1': true }, truncated: false, ordersLoaded: true,
  open: [{ id: 'p1', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders: [item(1, 0), item(2, 1)] as never }],
  recent: [{ id: 'p0', tracking_number: '884512209', carrier: 'Tirupati Courier', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-20T05:00:00Z', pushed_by: 'owner@example.test', pushed_at: '2026-09-20T09:00:00Z', orders: [item(7, 0, 'fulfilled')] as never }],
  ...changes,
})
const render = (p: DispatchScreenProps) => renderToString(createElement(DispatchScreen, p)).replace(/<!-- -->/g, '')

describe('Dispatch screen', () => {
  it('shows staged parcels with their added order, QC badges and the push count', () => {
    const html = render(props())
    expect(html).toContain('Qimati1'); expect(html).toContain('value="X1234567"')
    expect(html).toMatch(/same parcel[\s\S]*Qimati2|Qimati2[\s\S]*same parcel/)
    expect(html).toContain('aria-label="QC checked"'); expect(html).toContain('aria-label="QC not checked"')
    expect(html).toContain('Push 0 parcels'); expect(html).toContain('Select all staged (1)')
    expect(html).toContain('<option value="DTDC" selected="">DTDC</option>')
  })
  it('lists the last 30 days of pushes', () => { const html = render(props()); expect(html).toContain('Qimati7'); expect(html).toContain('Tirupati Courier 884512209'); expect(html).toContain('owner@example.test') })
  it('says when Shopify access is missing or the list was cut short', () => {
    expect(render(props({ orders: [], open: [], error: 'Loupe cannot read or fulfil orders yet.' }))).toContain('role="alert"')
    expect(render(props({ truncated: true }))).toContain('more than 300 open orders')
  })
  it('offers a way out for staged work whose order left the list', () => { expect(render(props({ orders: [] }))).toContain('no longer In progress') })
  it('does not invite a discard while the Shopify order list itself failed to load', () => {
    const html = render(props({ orders: [], ordersLoaded: false }))
    expect(html).not.toContain('no longer In progress'); expect(html).not.toContain('Discard')
  })
})
