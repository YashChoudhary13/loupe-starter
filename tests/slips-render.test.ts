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
const doc = (rows: SlipPrintRow[], orders: SlipOrder[]) => renderSlipDocument({ rows, orders, title: 'T', printedBy: 'owner', printedAt: '2026-10-10T09:00:00Z', backHref: '/dispatch/print' })

describe('the mark strip (packing_list.py mark(), plus the courier cell in the middle, D162)', () => {
  it('keeps the Mac wording in the left cell, Need Address in the right cell', () => {
    expect(strip('PACK', { ...empty, flags: [NEED_ADDRESS] })).toBe(`<div class=l><b>PACK</b></div><div class=c></div><div class=r><em>${NEED_ADDRESS}</em></div>`)
    expect(strip('CLUB', { ...empty, heldWith: [85], with: [{ number: 85, status: 'HOLD' }] })).toBe('<div class=l><b>CLUB</b><i>→</i><div class=w><b>85</b><small>HOLD</small></div></div><div class=c></div><div class=r></div>')
    expect(strip('PACK', empty)).toBe('<div class=l><b>PACK</b></div><div class=c></div><div class=r></div>')
    expect(strip('CLUB + HOLD', { ...empty, flags: ['addresses differ, check before clubbing'] })).toBe('<div class=l><b>CLUB + HOLD</b></div><div class=c></div><div class=r></div>')
  })
  it('names only a parcel leaving DTDC in the middle: DELHIVERY, INDIA POST; CHECK COURIER when the check failed; nothing for DTDC or without a pincode', () => {
    expect(strip('PACK', { ...empty, carrier: 'DTDC' })).toContain('<div class=c></div>')
    expect(strip('HOLD', { ...empty, carrier: 'Delhivery' })).toContain('<div class=c>DELHIVERY</div>')
    expect(strip('CLUB', { ...empty, carrier: 'Speed Post' })).toContain('<div class=c>INDIA POST</div>')
    expect(strip('PACK', { ...empty, carrier: 'Tirupati' })).toContain('<div class=c>TIRUPATI</div>')
    expect(strip('PACK', { ...empty, carrier: null })).toContain('<div class=c>CHECK COURIER</div>')
    expect(strip('PACK', empty)).toContain('<div class=c></div>')
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
  it('carries no script: the Print slips page opens the dialog from a hidden frame (D152)', () => {
    expect(doc([row(1)], [order(1)])).not.toContain('<script')
    expect(doc([row(1)], [order(1)])).toContain('onclick="window.print()"')
  })
  it('prints the courier inside the strip, so on a HOLD slip it is white on the black band, and warns when a check failed', () => {
    const html = doc([row(1, 'HOLD', { strip: { ...empty, carrier: 'Delhivery' } }), row(2, 'PACK', { strip: { ...empty, carrier: null } })], [order(1), order(2)])
    expect(html).toContain('<section class="slip HOLD" data-order="Qimati1"><div class=mark><div class=l><b>HOLD</b></div><div class=c>DELHIVERY</div><div class=r></div></div>')
    expect(html).toContain('.HOLD .mark,.CLUBHOLD .mark{background:#000;color:#fff}'); expect(html).toContain('grid-template-columns:1fr auto 1fr')
    expect(html).toContain('<div class=c>CHECK COURIER</div>'); expect(html).toContain('so the slip says CHECK COURIER: Qimati2')
    expect(doc([row(1)], [order(1)])).not.toContain('CHECK COURIER')
  })
  it('names orders Shopify could not return and orders not marked In progress', () => {
    const html = doc([row(1, 'PACK', { progress: 'failed', progress_error: 'no' }), row(2)], [order(1)])
    expect(html).toContain('Not marked In progress in Shopify (mark by hand or use Retry on the Print slips page): Qimati1')
    expect(html).toContain('Could not be read from Shopify: Qimati2'); expect(html).toContain('Order Qimati2')
  })
})
