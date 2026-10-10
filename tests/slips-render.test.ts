import { describe, expect, it } from 'vitest'
import { renderSlipDocument, strip } from '@/lib/slips/render'
import { NEED_ADDRESS, type SlipOrder, type SlipPrintRow } from '@/lib/slips/types'

const empty = { detail: '', flags: [], how: [], heldWith: [], with: [] }
const row = (n: number, mark: SlipPrintRow['mark'] = 'PACK', changes: Partial<SlipPrintRow> = {}): SlipPrintRow => ({ id: `r${n}`, batch_id: 'b1', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, order_number: n, mark, strip: empty, progress: 'marked', progress_error: null, printed_at: '2026-10-10T09:00:00Z', ...changes })
const order = (n: number): SlipOrder => ({
  id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-10-09T18:30:00Z', note: 'Pack  with <care>', tags: [], email: null, phone: null, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', total: 100, customer: null,
  shippingAddress: { name: 'A & B', phone: '98', address1: '1 St', address2: null, city: 'Jaipur', provinceCode: 'RJ', zip: '302001', country: 'India' }, billingAddress: null, fulfillmentOrders: [],
  lines: [{ title: 'Ring', variantTitle: 'Red', sku: 'RS1', quantity: 3, unfulfilledQuantity: 2, requiresShipping: true, imageUrl: 'https://cdn/x.jpg' }, { title: 'Tip', variantTitle: null, sku: 'TIP', quantity: 1, unfulfilledQuantity: 1, requiresShipping: false, imageUrl: null }],
})
const doc = (rows: SlipPrintRow[], orders: SlipOrder[], auto = false) => renderSlipDocument({ rows, orders, title: 'T', printedBy: 'owner', printedAt: '2026-10-10T09:00:00Z', auto, backHref: '/dispatch/print' })

describe('the mark strip (packing_list.py mark())', () => {
  it('matches the Mac output byte for byte', () => {
    expect(strip('PACK', { ...empty, flags: [NEED_ADDRESS] })).toBe(`<b>PACK</b><em>${NEED_ADDRESS}</em>`)
    expect(strip('CLUB', { ...empty, heldWith: [85], with: [{ number: 85, status: 'HOLD' }] })).toBe('<b>CLUB</b><i>→</i><div class=w><b>85</b><small>HOLD</small></div>')
    expect(strip('PACK', empty)).toBe('<b>PACK</b>')
    expect(strip('CLUB + HOLD', { ...empty, flags: ['addresses differ, check before clubbing'] })).toBe('<b>CLUB + HOLD</b>')
  })
})
describe('the slip document', () => {
  it('renders one slip per printed row in order, only shipping lines, the note, and escapes everything', () => {
    const html = doc([row(2, 'HOLD'), row(1), row(3, 'BASELINE')], [order(1), order(2)])
    expect(html.match(/class="slip /g)).toHaveLength(2)
    expect(html.indexOf('Order Qimati1')).toBeLessThan(html.indexOf('Order Qimati2'))
    expect(html).toContain('class="slip HOLD"'); expect(html).not.toContain('Qimati3')
    expect(html).toContain('<div>Ring</div><div>Red</div><div>RS1</div></td><td class=q>2 of 3</td>'); expect(html).not.toContain('TIP')
    expect(html).toContain('<div>A &amp; B</div>'); expect(html).toContain('Pack with &lt;care&gt;'); expect(html).toContain('October 10, 2026')
    expect(html).toContain('2 slips · Qimati1 to Qimati2'); expect(html).not.toContain('<script>')
  })
  it('keeps Chrome\'s print headers and footers off the paper: zero page margin, the margins on the slip', () => {
    const html = doc([row(1)], [order(1)])
    expect(html).toContain('@page{size:A4;margin:0}'); expect(html).toContain('@media print{.toolbar{display:none}.slip{padding:10mm 30mm 14mm;box-sizing:border-box}}')
  })
  it('opens the print dialog only when asked, and only when there is something to print', () => {
    expect(doc([row(1)], [order(1)], true)).toContain('window.print()},300)')
    expect(doc([row(3, 'BASELINE')], [], true)).not.toContain('<script>')
  })
  it('names orders Shopify could not return and orders not marked In progress', () => {
    const html = doc([row(1, 'PACK', { progress: 'failed', progress_error: 'no' }), row(2)], [order(1)])
    expect(html).toContain('Not marked In progress in Shopify (mark by hand or use Retry on the Print slips page): Qimati1')
    expect(html).toContain('Could not be read from Shopify: Qimati2'); expect(html).toContain('Order Qimati2')
  })
})
