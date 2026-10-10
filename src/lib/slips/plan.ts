import { MARKS, NEED_ADDRESS, type Mark, type SlipLine, type SlipOrder, type SlipRow, type SlipStrip } from './types'

/**
 * The packing-list rules, ported line for line from the owner's `packing_list.py` (the Mac skill, rules fixed by the
 * owner between 2026-09-28 and 2026-10-07). Pure: no I/O, no clock. The selftest cases travel with it in
 * tests/slips-plan.test.ts, so a verdict here and a verdict on the Mac can be compared.
 */
export const PAID = new Set(['PAID', 'PARTIALLY_REFUNDED'])
const HOLD_WORDS = /hold|wait|confirm|pending/i
export const MISSING = 'not in Shopify'
export const ADDRESSES_DIFFER = 'addresses differ, check before clubbing'

export const num = (name: string): number => Number(name.replace(/\D/g, '') || 0)
export const norm = (text: string | null | undefined): string => (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
export const status = (o: SlipOrder): string => o.fulfillmentStatus.replace(/_/g, ' ').toLowerCase()
export const pay = (o: SlipOrder): string => o.financialStatus.replace(/_/g, ' ').toLowerCase()
export const paid = (o: SlipOrder): boolean => PAID.has(o.financialStatus)
export const name = (o: SlipOrder): string => o.shippingAddress?.name || o.customer?.displayName || MISSING
export const city = (o: SlipOrder): string => o.shippingAddress?.city || MISSING
export const lines = (o: SlipOrder): SlipLine[] => o.lines.filter(line => line.requiresShipping && line.unfulfilledQuantity > 0)
export const units = (o: SlipOrder): number => lines(o).reduce((sum, line) => sum + line.unfulfilledQuantity, 0)
export const item = (line: SlipLine): string => line.title + (line.variantTitle && line.variantTitle !== 'Default Title' ? ` / ${line.variantTitle}` : '')

/** Digits with country code, or null. Note text only yields a clear mobile number, never a date or order number. */
export function phoneDigits(raw: string | null | undefined, fromNote = false): string | null {
  let d = (raw ?? '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '91' + d
  if (fromNote) {
    const indian = d.length === 12 && d.startsWith('91') && '6789'.includes(d[2])
    return indian || ((raw ?? '').trim().startsWith('+') && d.length >= 11 && d.length <= 15) ? d : null
  }
  return d.length >= 11 ? d : null
}
const unique = (values: (string | null)[]): string[] => [...new Set(values)].filter((value): value is string => !!value)
export const contactPhones = (o: SlipOrder): string[] => unique([o.phone, o.shippingAddress?.phone, o.billingAddress?.phone, o.customer?.phone].map(value => phoneDigits(value)))
export const notePhones = (o: SlipOrder): string[] => unique(((o.note ?? '').match(/\+?\d[\d \-]{8,}\d/g) ?? []).map(found => phoneDigits(found, true)))
export function showPhone(o: SlipOrder): string {
  const d = contactPhones(o)[0] ?? notePhones(o)[0]
  if (!d) return MISSING
  return d.length === 12 && d.startsWith('91') ? `${d.slice(2, 7)} ${d.slice(7)}` : '+' + d
}

type Key = [kind: string, value: string]
function keys(o: SlipOrder): Key[] {
  const out: Key[] = [...contactPhones(o).map((d): Key => ['phone', d]), ...notePhones(o).map((d): Key => ['phone in note', d])]
  for (const email of new Set([(o.email ?? '').trim().toLowerCase(), (o.customer?.email ?? '').trim().toLowerCase()])) if (email) out.push(['email', email])
  if (o.customer?.id) out.push(['customer account', o.customer.id])
  const ship = o.shippingAddress
  if (ship?.address1 && ship.name) out.push(['name and address', [ship.name, ship.address1, ship.zip].map(norm).join('|')])
  const words = (ship?.name ?? '').toLowerCase().match(/[a-z]{2,}/g) ?? []
  if (words.length >= 2 && ship?.zip) out.push(['name and pincode', words.join('|') + '|' + norm(ship.zip)]) // a full name at one pincode; people retype their street differently
  return out
}

/** Same customer = shared phone, email, customer account or name plus address. Returns id → group, id → how. */
export function customers(orders: SlipOrder[]): { group: Map<string, SlipOrder[]>; how: Map<string, string[]> } {
  const parent = new Map(orders.map(o => [o.id, o.id]))
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)! } return x }
  const first = new Map<string, [id: string, kind: string]>()
  const links: [id: string, kind: string][] = []
  for (const o of orders) {
    for (const [kind, value] of keys(o)) {
      const k = `${kind.startsWith('phone') ? 'phone' : kind}\u0000${value}`
      const seen = first.get(k)
      if (!seen) { first.set(k, [o.id, kind]); continue }
      const [other, otherKind] = seen
      if (other === o.id) continue // the note repeats this order's own number
      links.push([o.id, kind === 'phone in note' || otherKind === 'phone in note' ? 'phone in note' : kind])
      parent.set(find(o.id), find(other))
    }
  }
  const groups = new Map<string, SlipOrder[]>(), hows = new Map<string, Set<string>>()
  for (const o of orders) { const root = find(o.id); groups.set(root, [...(groups.get(root) ?? []), o]) }
  for (const [id, kind] of links) { const root = find(id); hows.set(root, new Set([...(hows.get(root) ?? []), kind])) }
  return { group: new Map(orders.map(o => [o.id, groups.get(find(o.id))!])), how: new Map(orders.map(o => [o.id, [...(hows.get(find(o.id)) ?? [])].sort()])) }
}

export function holdReason(o: SlipOrder): string {
  const why: string[] = []
  const held = o.fulfillmentOrders.filter(fo => fo.status === 'ON_HOLD')
  if (held.length || o.fulfillmentStatus === 'ON_HOLD') {
    const said = [...new Set(held.flatMap(fo => fo.holdReasons))].filter(reason => reason !== 'other').sort()
    why.push('on hold in Shopify' + (said.length ? ` (${said.join(', ')})` : ''))
  }
  if (o.fulfillmentStatus === 'SCHEDULED') why.push('scheduled in Shopify')
  const note = (o.note ?? '').split(/\s+/).filter(Boolean).join(' ')
  if (HOLD_WORDS.test(note)) why.push(`note says "${note.slice(0, 80)}"`)
  const tags = o.tags.filter(tag => HOLD_WORDS.test(tag))
  if (tags.length) why.push('tag ' + tags.join(', '))
  return why.join('; ')
}

const byNumber = (a: SlipOrder, b: SlipOrder) => num(a.name) - num(b.name)
/** Rows for the in-range paid orders, ascending. Every open paid order counts when finding the same customer. */
export function plan(open: SlipOrder[], inRange: (o: SlipOrder) => boolean): SlipRow[] {
  const orders = open.filter(paid) // payment not received: never on the list or the slips (owner, 2026-10-07)
  const { group, how } = customers(orders)
  const reason = new Map(orders.map(o => [o.id, holdReason(o)]))
  const rowsIn = orders.filter(inRange).sort(byNumber)
  const low = rowsIn.length ? num(rowsIn[0].name) : 0
  const tag = (o: SlipOrder) => `${num(o.name)} (${inRange(o) ? '' : num(o.name) < low ? 'older, ' : 'newer, '}${reason.get(o.id) ? 'HOLD' : status(o)})`
  const rows: SlipRow[] = []
  for (const o of rowsIn) {
    const same = group.get(o.id)!
    const others = same.filter(x => x !== o).sort(byNumber)
    const heldWith = others.filter(x => reason.get(x.id)).map(x => num(x.name))
    let mark: Mark, detail: string
    if (reason.get(o.id)) {
      mark = others.length ? 'CLUB + HOLD' : 'HOLD'
      detail = reason.get(o.id)! + (others.length ? `; same customer: ${others.map(tag).join(', ')}` : '')
    } else if (others.length) {
      const main = same.reduce((best, x) => (byNumber(x, best) < 0 ? x : best))
      mark = 'CLUB'
      detail = (main === o ? 'main; add ' : `put in ${num(main.name)} parcel; with `) + others.map(tag).join(', ')
      if (heldWith.length) detail += ' · bring from hold: ' + heldWith.join(', ') // a clear new order ships now, together with the customer's held parcel
    } else { mark = 'PACK'; detail = '' }
    const flags: string[] = o.shippingAddress?.address1 ? [] : [NEED_ADDRESS]
    if (others.length && new Set(same.map(x => `${norm(x.shippingAddress?.address1)}|${norm(x.shippingAddress?.zip)}`)).size > 1) flags.push(ADDRESSES_DIFFER)
    if (o.tags.includes('high')) flags.push('risk tag high')
    if (!lines(o).length) flags.push('no units left to ship')
    const strip: SlipStrip = { detail, flags, how: how.get(o.id) ?? [], heldWith, with: others.map(x => ({ number: num(x.name), status: reason.get(x.id) ? 'HOLD' : status(x).replace(/^./, c => c.toUpperCase()) })) }
    rows.push({ order: o, mark, strip })
  }
  return rows
}
export const isHeld = (mark: Mark | 'BASELINE'): boolean => mark === 'HOLD' || mark === 'CLUB + HOLD'
export const isMark = (value: unknown): value is Mark => typeof value === 'string' && (MARKS as readonly string[]).includes(value)
