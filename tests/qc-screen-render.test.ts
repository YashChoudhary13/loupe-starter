import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/link', () => ({ default: (props: { href: string; children: unknown }) => createElement('a', { href: props.href }, props.children as string) }))
import { QcScreen } from '@/components/qc/QcScreen'
import { QcHistoryScreen } from '@/components/qc/QcHistoryScreen'
import type { QcEvent, QcSession, QcShortage, QcView } from '@/lib/qc/types'

const line = (id: string, variantId: string, required: number, title: string, variantTitle: string | null, image: string | null) => ({ id, variantId, title, variantTitle, sku: `${id}-SKU`, barcode: `${id}-SKU`, required, image })
const order = {
  id: 'gid://shopify/Order/1', name: 'Qimati5713', updatedAt: '2026-09-18T08:00:00Z', cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null,
  lines: [line('gid://shopify/LineItem/1', 'v1', 3, 'Rings 004', 'Gold / 7', 'https://cdn.shopify.com/s/files/ring.jpg'), line('gid://shopify/LineItem/2', 'v2', 1, 'Necklace 1062', null, null)],
}
const session: QcSession = { id: 's', order_id: order.id, fingerprint: 'a'.repeat(64), snapshot: { ...order, lines: order.lines.map(l => ({ ...l, image: undefined })) }, counts: { 'gid://shopify/LineItem/1': 1 }, status: 'checking', generation: 1, version: 5, checked_at: '2026-09-18T08:00:00Z', completed_at: null, completed_by: null }
const shortage: QcShortage = { id: 'sh', ref: 12, session_id: 's', event_id: 'e2', order_id: order.id, order_name: order.name, generation: 1, line_id: 'gid://shopify/LineItem/1', variant_id: 'v1', sku: 'gid://shopify/LineItem/1-SKU', title: 'Rings 004', variant_title: 'Gold / 7', quantity: 1, reason: 'Not in stock', reported_by: 'Checker', reported_at: '2026-09-18T08:01:00Z', resolved_at: null, resolved_by: null, resolution: null, resolution_note: null }
const events: QcEvent[] = [
  { id: 'e2', action: 'short', outcome: 'short', message: 'Marked 1 short: Rings 004 · Gold / 7.', code: null, line_id: 'gid://shopify/LineItem/1', variant_id: 'v1', actor_id: 'op', actor_name: 'Checker', created_at: '2026-09-18T08:01:00Z', generation: 1, undo_of: null },
  { id: 'e1', action: 'scan', outcome: 'accepted', message: 'Checked 1 unit: Rings 004 · Gold / 7', code: 'gid://shopify/LineItem/1-SKU', line_id: 'gid://shopify/LineItem/1', variant_id: 'v1', actor_id: 'op', actor_name: 'Checker', created_at: '2026-09-18T08:00:30Z', generation: 1, undo_of: null },
]
const view: QcView = { order, session, events, shortages: [shortage], operatorId: 'op' }
// React server rendering separates adjacent text nodes with comment markers.
const render = (element: ReturnType<typeof createElement>) => renderToString(element).replace(/<!-- -->/g, '')

describe('QC screens render from a saved view', () => {
  it('shows thumbnails from the fresh order read, per-line short state, the shortage list and the missing necklace', () => {
    const html = render(createElement(QcScreen, { initialView: view }))
    expect(html).toContain('src="https://cdn.shopify.com/s/files/ring.jpg"')
    expect(html).toContain('1 to scan · 1 short')
    expect(html).toContain('Accepted as short')
    expect(html).toContain('#12 · Rings 004')
    expect(html).toContain('Don’t have it · mark 1 short')
    expect(html).toContain('Necklace 1062')
    expect(html).toContain('Complete QC · 1 short')
    expect(html).toContain('Use phone camera instead')
    expect(html).not.toContain('<video')
  })
  it('renders the read-only history record with the pass, the shortage and the events', () => {
    const passed: QcSession = { ...session, status: 'stale', counts: { 'gid://shopify/LineItem/1': 2, 'gid://shopify/LineItem/2': 1 } }
    const pass: QcEvent = { ...events[0], id: 'e3', action: 'complete', outcome: 'passed', message: 'QC passed with 1 unit(s) short.', line_id: null, variant_id: null, created_at: '2026-09-18T08:05:00Z' }
    const html = render(createElement(QcHistoryScreen, { session: passed, events: [pass, ...events], shortages: [shortage] }))
    expect(html).toContain('Passed, then the order changed')
    expect(html).toContain('✓ Passed')
    expect(html).toContain('Open — refund or coupon pending')
    expect(html).toContain('Open live checklist')
    expect(html).toContain('QC history · 3 events')
  })
})
