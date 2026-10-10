import { describe, expect, it } from 'vitest'
import { ADDRESSES_DIFFER, holdReason, num, plan, showPhone, units } from '@/lib/slips/plan'
import { NEED_ADDRESS, type SlipLine, type SlipOrder } from '@/lib/slips/types'

/** The owner's `packing_list.py --selftest` cases, kept identical so the Mac rules and Loupe's can be compared. */
const L = (sku: string, q: number, ships = true): SlipLine => ({ title: 'Item ' + sku, variantTitle: null, sku, quantity: q, unfulfilledQuantity: q, requiresShipping: ships, imageUrl: null })
interface Opts { phone?: string; email?: string; fin?: string; ful?: string; held?: boolean; note?: string; addr?: string | null; items?: SlipLine[]; nm?: string }
const O = (n: number, { phone, email, fin = 'PAID', ful = 'UNFULFILLED', held = false, note, addr = '1 Main St', items, nm }: Opts = {}): SlipOrder => ({
  id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-09-27T05:00:00Z', note: note ?? null, tags: [], email: email ?? null, phone: phone ?? null,
  financialStatus: fin, fulfillmentStatus: held ? 'ON_HOLD' : ful, total: 100, customer: null, billingAddress: null,
  shippingAddress: addr ? { name: nm ?? `Buyer ${n}`, phone: null, address1: addr, address2: null, city: 'Jaipur', provinceCode: null, zip: '302001', country: null } : null,
  fulfillmentOrders: [{ id: `gid://shopify/FulfillmentOrder/${n}`, status: held ? 'ON_HOLD' : 'OPEN', holdReasons: held ? ['other'] : [] }],
  lines: items ?? [L('RS9', 1)],
})
const orders = [O(100, { phone: '+91 98475 44749', held: true }), O(90, { phone: '9847544749', held: true }), // same phone, two formats
  O(101, { phone: '7000000001', email: 'x@y.in' }), O(102, { phone: '7000000009', email: 'X@Y.in ', ful: 'IN_PROGRESS' }), // same email
  O(103, { phone: '5700000012', fin: 'PENDING' }), O(117, { phone: '5700000012', addr: null }), // unpaid: left out, even from CLUB
  O(104, { note: 'Customer to confirm colour' }),
  O(105, { note: 'Customer mobile +965 6601 3733' }), O(80, { phone: '+96566013733' }), // phone only in the note
  O(106, { phone: '8000000002', items: [L('TIP', 1, false), L('RS1', 0), L('NK2', 2)] }),
  O(107, { phone: '9000000003', addr: '1 A St' }), O(108, { phone: '9000000003', addr: '9 B Rd' }),
  O(109, { phone: '6000000004', note: 'ship after 27-09-2026' }), O(110, { phone: '6000000005', note: 'ship after 27-09-2026' }),
  O(111, { phone: '9111111111', note: 'call 9111111111' }), // note repeats the order's own number
  O(85, { phone: '5500000007', held: true }), O(112, { phone: '5500000007' }), // clubbed into a held parcel
  O(113, { phone: '5600000008', nm: 'Asha Rani Verma', addr: '12 Lake View Rd' }), O(114, { phone: '5600000009', nm: 'Asha Rani Verma', addr: '12, lake view road' }),
  O(115, { phone: '5600000010', nm: 'Priya .', addr: '3 X St' }), O(116, { phone: '5600000011', nm: 'Priya .', addr: '4 Y St' })] // one-word name: no link
const rows = plan(orders, o => num(o.name) >= 100 && num(o.name) <= 117)
const by = Object.fromEntries(rows.map(row => [num(row.order.name), row]))

describe('packing-list rules (packing_list.py selftest)', () => {
  it('lists every paid in-range order once, ascending', () => { expect(rows.map(row => num(row.order.name))).toEqual([100, 101, 102, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117]) })
  it('matches a phone written two ways, into a held parcel', () => {
    expect([by[100].mark, by[100].strip.detail]).toEqual(['CLUB + HOLD', 'on hold in Shopify; same customer: 90 (older, HOLD)'])
    expect(by[100].strip.with).toEqual([{ number: 90, status: 'HOLD' }])
  })
  it('matches an email regardless of case and spacing, naming the in-progress sibling', () => {
    expect([by[101].mark, by[101].strip.detail]).toEqual(['CLUB', 'main; add 102 (in progress)'])
    expect(by[101].strip.with).toEqual([{ number: 102, status: 'In progress' }])
    expect(by[102].strip.detail).toBe('put in 101 parcel; with 101 (unfulfilled)'); expect(by[102].strip.how).toEqual(['email'])
  })
  it('leaves an unpaid order out entirely, even as a CLUB link; a missing address is a flag, not a hold', () => {
    expect(by[103]).toBeUndefined()
    expect([by[117].mark, by[117].strip.detail, by[117].strip.flags]).toEqual(['PACK', '', [NEED_ADDRESS]])
    expect(by[101].strip.flags).not.toContain(NEED_ADDRESS)
  })
  it('holds on a note word and names it', () => { expect(by[104].mark).toBe('HOLD'); expect(by[104].strip.detail).toBe('note says "Customer to confirm colour"') })
  it('finds a customer by the mobile number written in the note', () => { expect(by[105].strip.detail).toBe('put in 80 parcel; with 80 (older, unfulfilled)'); expect(by[105].strip.how).toEqual(['phone in note']) })
  it('counts only lines that ship and still have units', () => { expect(by[106].mark).toBe('PACK'); expect(units(by[106].order)).toBe(2) })
  it('clubs the same phone at two addresses with a warning', () => { expect(by[107].mark).toBe('CLUB'); expect(by[107].strip.flags).toContain(ADDRESSES_DIFFER) })
  it('does not read a date in a note as a phone number', () => { expect([by[109].mark, by[110].mark]).toEqual(['PACK', 'PACK']) })
  it('ignores a note that repeats the order\'s own number', () => { expect(by[111].mark).toBe('PACK'); expect(by[111].strip.how).toEqual([]) })
  it('ships a clear new order together with the customer\'s held parcel', () => {
    expect([by[112].mark, by[112].strip.heldWith, by[112].strip.with]).toEqual(['CLUB', [85], [{ number: 85, status: 'HOLD' }]])
    expect(by[112].strip.detail).toBe('put in 85 parcel; with 85 (older, HOLD) · bring from hold: 85'); expect(by[101].strip.heldWith).toEqual([])
  })
  it('matches a full name at one pincode even when the street is retyped', () => { expect(by[113].mark).toBe('CLUB'); expect(by[113].strip.how).toEqual(['name and pincode']); expect(by[113].strip.flags).toContain(ADDRESSES_DIFFER) })
  it('never links on a one-word name', () => { expect([by[115].mark, by[116].mark]).toEqual(['PACK', 'PACK']) })
  it('shows phones the Indian way and others with a plus', () => { expect(showPhone(orders[0])).toBe('98475 44749'); expect(showPhone(orders[7])).toBe('+96566013733') })
  it('names every hold reason', () => {
    expect(holdReason(O(1, { held: true }))).toBe('on hold in Shopify')
    expect(holdReason({ ...O(2), fulfillmentStatus: 'SCHEDULED', tags: ['Pending-check'] })).toBe('scheduled in Shopify; tag Pending-check')
    expect(holdReason({ ...O(3, { held: true }), fulfillmentOrders: [{ id: 'fo', status: 'ON_HOLD', holdReasons: ['awaiting payment', 'other'] }] })).toBe('on hold in Shopify (awaiting payment)')
  })
  it('marks siblings outside the range as older or newer, relative to the lowest printed order', () => {
    const later = plan(orders, o => num(o.name) === 101 || num(o.name) === 85)
    expect(later.map(row => row.strip.detail)).toEqual(['on hold in Shopify; same customer: 112 (newer, unfulfilled)', 'main; add 102 (newer, in progress)'])
  })
})
