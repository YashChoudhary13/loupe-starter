import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/authorize', () => ({ requireOperator: vi.fn() }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class {} }))
vi.mock('@/lib/shopify/qc-orders', () => ({ listQcOrders: vi.fn(), qcShopifyError: () => 'QC status unavailable' }))
vi.mock('@/lib/qc/server', () => ({ qcOrderStatuses: vi.fn(), listRecentPasses: vi.fn() }))
import Page from '@/app/(shell)/qc/page'
import { listQcOrders } from '@/lib/shopify/qc-orders'
import { listRecentPasses, qcOrderStatuses } from '@/lib/qc/server'

describe('QC order columns', () => {
  it('splits saved passes, shows HOLD box / Ready to ship and shorts, and labels incomplete page counts', async () => {
    const nodes = ['new', 'checking', 'stale', 'held-pass', 'pass'].map(id => ({ id, name: id, createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: id === 'held-pass' ? 'ON_HOLD' : 'UNFULFILLED' }))
    vi.mocked(listQcOrders).mockResolvedValue({ nodes, pageInfo: { hasNextPage: true, endCursor: 'next' } })
    vi.mocked(qcOrderStatuses).mockResolvedValue(Object.fromEntries(nodes.slice(1).map(order => [order.id, { status: order.id.endsWith('pass') ? 'passed' : order.id, checked_at: order.updatedAt, snapshotUpdatedAt: order.updatedAt }])))
    vi.mocked(listRecentPasses).mockResolvedValue([{ orderId: 'held-pass', orderName: 'held-pass', passedAt: nodes[0].updatedAt, passedBy: 'Checker', units: 3, short: 1, sessionStatus: 'passed' }])
    const html = renderToString(await Page({ searchParams: Promise.resolve({}) })).replace(/<!-- -->/g, '')
    const left = html.slice(html.indexOf('aria-labelledby="qc-to-check"'), html.indexOf('aria-labelledby="qc-checked"'))
    const right = html.slice(html.indexOf('aria-labelledby="qc-checked"'), html.indexOf('<details'))
    expect(left).toContain('To check · 3')
    for (const label of ['Not checked', 'In progress', 'Recount needed']) expect(left).toContain(label)
    expect(left).not.toContain('held-pass')
    expect(right).toContain('Checked · 2')
    for (const label of ['held-pass', 'HOLD box', 'Ready to ship', '1 short']) expect(right).toContain(label)
    expect(html).toContain('on this page')
    expect(html).toContain('More orders')
    expect(html).not.toMatch(/<details[^>]* open/)
  })
})
