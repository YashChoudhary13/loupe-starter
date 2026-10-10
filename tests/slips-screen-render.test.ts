import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('@/app/(shell)/dispatch/print/actions', () => ({ retryProgressAction: vi.fn() }))
import { PrintScreen, type PrintScreenProps } from '@/components/slips/PrintScreen'

const row = (n: number, mark: PrintScreenProps['rows'][number]['mark'] = 'PACK', detail = '') => ({ id: `gid://shopify/Order/${n}`, number: n, name: `Qimati${n}`, mark, detail, flags: [], how: [], customer: `Buyer ${n}`, phone: '98475 44749', city: 'Jaipur', units: 3, status: 'unfulfilled' })
const props = (changes: Partial<PrintScreenProps> = {}): PrintScreenProps => ({ rows: [row(1), row(2, 'CLUB', 'main; add 3 (older, in progress)'), row(4, 'HOLD', 'on hold in Shopify')], leftOut: ['Qimati5 (pending)'], unprinted: 3, truncated: false, oldest: 1,
  batches: [{ id: 'b1', printedBy: 'owner', printedAt: '2026-10-10T09:00:00Z', count: 12, fromNumber: null, first: 6098, last: 6110, baseline: 0, failed: [{ name: 'Qimati6100', error: 'Shopify refused.' }] }], ...changes })
const render = (p: PrintScreenProps) => renderToString(createElement(PrintScreen, p)).replace(/<!-- -->/g, '')

describe('Print slips screen', () => {
  it('lists the unprinted orders with marks, a form that posts to /api/slips, and the batches with Reprint and Retry', () => {
    const html = render(props())
    expect(html).toContain('action="/api/slips"'); expect(html).toContain('Print 3 slips')
    expect(html).toContain('PACK 1 · CLUB 1 · HOLD 1 · CLUB + HOLD 0 · 6 units to pack')
    expect(html).toContain('main; add 3 (older, in progress)'); expect(html).toContain('Left out, payment not received: Qimati5 (pending)')
    expect(html).toContain('href="/api/slips/b1"'); expect(html).toContain('Retry marking 1 order'); expect(html).toContain('Qimati6100 (Shopify refused.)')
    expect(html).toContain('12 slips'); expect(html).toContain('Qimati6098 to Qimati6110')
  })
  it('turns Print off on an incomplete list or when nothing is left', () => {
    expect(render(props({ truncated: true }))).toMatch(/<button type="submit"[^>]*disabled=""/)
    expect(render(props({ rows: [], leftOut: [], unprinted: 0, oldest: null }))).toContain('Every open paid order has a slip.')
  })
})
