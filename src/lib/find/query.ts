/** Find (D173): what the operator typed, and the rules that need no server. The screen, the routes and the tests share it. */

export type FindQuery = { kind: 'order'; key: string } | { kind: 'product'; key: string }

/** Digits are an order number ("8524", "Qimati8524", "#8524"); letters then digits are a product code ("rs514", "RS514-Gold"). */
export function parseQuery(text: string): FindQuery | null {
  const typed = text.toUpperCase().replace(/QIMATI/g, '').replace(/[^A-Z0-9]/g, '')
  if (/^\d{1,8}$/.test(typed)) return { kind: 'order', key: typed.replace(/^0+(?=\d)/, '') }
  const code = /^[A-Z]{1,4}(?=\d|$)\d{0,8}/.exec(typed)?.[0]
  return code ? { kind: 'product', key: code } : null
}

/** "8626, 8501" or "Qimati8626 + 8501" → [8626, 8501]: the slip's own order first, no repeats. */
export function orderNumbersFrom(text: string): number[] {
  const found = (text.match(/\d+/g) ?? []).filter(run => run.length <= 8).map(Number).filter(n => n > 0)
  return [...new Set(found)]
}

export interface Tracking { carrier: string; number: string; url: string | null }

/** Tracking pages we know take the number in the link. Any other courier keeps the link Shopify has, or none. */
const PAGES: readonly (readonly [RegExp, (number: string) => string])[] = [
  [/dtdc/i, number => `https://www.dtdc.com/track-your-shipment/?awb=${encodeURIComponent(number)}`],
  [/delhivery/i, number => `https://www.delhivery.com/track/package/${encodeURIComponent(number)}`],
]
export function trackingUrl(carrier: string, number: string, shopifyUrl: string | null): string | null {
  const known = PAGES.find(([name]) => name.test(carrier))
  if (known) return known[1](number)
  return shopifyUrl && /^https:\/\//i.test(shopifyUrl) ? shopifyUrl : null
}

/** What the reader took from one photograph. Every field is "what the picture seems to say", never a fact. */
export interface SlipRead { orders: number[]; pincode: string | null; sticker: string | null }
/** What Shopify says about one order number. `tracking` is empty until the order is fulfilled. */
export interface OrderFacts { number: number; found: boolean; zip: string | null; tracking: readonly string[] }
export interface Verdict { status: 'matched' | 'review'; orders: number[]; problem: string | null }

const pin = (value: string | null) => (value ?? '').replace(/\D/g, '')
const name = (number: number) => `Qimati${number}`

/**
 * A photograph is shown to the support desk without a person only when the order number read from the slip is a
 * Shopify order AND the PIN code read from the slip is that order's PIN code. A misread digit lands on another
 * buyer's order; the PIN code is what catches it. Two buyers can share a PIN code, so when the order already has a
 * tracking number the courier sticker in the photograph is a second witness: a sticker that is clearly another number
 * sends the photograph to a person. Everything else waits for a person too, with the reading as a suggestion.
 */
export function judgeRead(read: SlipRead, facts: readonly OrderFacts[]): Verdict {
  const orders = [...new Set(read.orders.filter(n => Number.isSafeInteger(n) && n > 0 && n < 100_000_000))]
  if (!orders.length) return { status: 'review', orders, problem: 'No order number could be read from this photo.' }
  const fact = (number: number) => facts.find(item => item.number === number)
  const first = fact(orders[0])
  if (!first?.found) return { status: 'review', orders, problem: `Read ${name(orders[0])}, which is not an order in Shopify.` }
  const zip = pin(first.zip)
  if (zip.length !== 6 || pin(read.pincode) !== zip) return { status: 'review', orders, problem: `Read ${name(orders[0])}, but the PIN code on the slip does not confirm it.` }
  if (stickerDiffers(read.sticker, first.tracking)) return { status: 'review', orders, problem: `Read ${name(orders[0])}, but the courier sticker in the photo is not that order's tracking number.` }
  // Another order in the same parcel goes to the same address. One that does not is a misread, or a slip that only names it.
  const stray = orders.slice(1).find(number => !fact(number)?.found || pin(fact(number)?.zip ?? null) !== zip)
  if (stray !== undefined) return { status: 'review', orders, problem: `${name(orders[0])} is confirmed, but ${name(stray)} on the slip could not be confirmed as part of this parcel.` }
  return { status: 'matched', orders, problem: null }
}

/** The sticker as stored: capitals and digits only, or null when what was read is not a plausible consignment number. */
export function cleanSticker(value: string | null | undefined): string | null {
  const plain = (value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  return plain.length >= 6 && plain.length <= 30 ? plain : null
}

/** Minimum edits between two short strings. Only used to tell "the same sticker, one digit misread" from "another sticker". */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/**
 * True when the sticker in the photograph is clearly not one of the order's tracking numbers (the parcel was booked
 * again with another courier after the photograph, or the photograph is of another parcel). The sticker is a model's
 * reading, so a difference of one or two characters is taken as a misread of the same number, not as another sticker.
 */
export function stickerDiffers(sticker: string | null, numbers: readonly string[]): boolean {
  if (!sticker || !numbers.length) return false
  return numbers.every(number => editDistance(sticker, number.toUpperCase().replace(/[^0-9A-Z]/g, '')) > 2)
}

// What the routes answer and the screens draw.
export interface ParcelHit { order: number; photoId: string; thumbUrl: string | null; orders: number[]; sticker: string | null; at: string }
export interface RawHit { code: string; kind: 'phone' | 'original'; photoId: string; thumbUrl: string | null; at: string }
export type FindResult = { kind: 'order'; key: string; parcels: ParcelHit[] } | { kind: 'product'; key: string; photos: RawHit[] }
export interface OrderLive { number: number; found: boolean; cancelled: boolean; tracking: Tracking[]; shippedAt: string | null }
export type ParcelStatus = 'pending' | 'review' | 'matched' | 'dismissed'
export interface ParcelRow { id: string; status: ParcelStatus; orders: number[]; sticker: string | null; problem: string | null; filename: string; thumbUrl: string | null; by: string; confirmedBy: string | null; at: string }
export interface ParcelLists { review: ParcelRow[]; recent: ParcelRow[] }
/** `duplicate`: this photograph (same file name, same size) is already here, so nothing is uploaded. */
export type BeginParcel = { duplicate: true } | { duplicate: false; id: string; uploadUrl: string; contentType: string; thumbUploadUrl: string }
export type PhotoKind = 'parcel' | 'phone' | 'original'
/** Where the browser loads a full photograph: a route on Loupe's own host, so it caches and can be drawn on a canvas. */
export const photoSrc = (kind: PhotoKind, id: string, download?: string): string => `/api/find/photo?kind=${kind}&id=${id}${download ? `&download=${encodeURIComponent(download)}` : ''}`

// What the screen draws for one answer.
export type View =
  | { type: 'order'; number: number; photos: ParcelHit[] }
  | { type: 'product'; code: string; photos: RawHit[] }
  | { type: 'list'; rows: { go: string; thumbUrl: string | null; title: string; note: string }[] }
  | { type: 'none'; kind: 'order' | 'product'; key: string }

export const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item])
  return groups
}

/**
 * An exact match is shown as a card; others are a list to pick from. A parcel photograph shows a buyer's address, so
 * an order's card is only ever drawn for the whole number that was typed: the one order matching the first digits is
 * a row to pick, never a card that Enter would copy. A product code's only match is its card (nothing private there).
 */
export function viewOf(result: FindResult): View {
  if (result.kind === 'order') {
    const orders = groupBy(result.parcels, hit => hit.order), exact = orders.get(Number(result.key))
    if (exact) return { type: 'order', number: Number(result.key), photos: exact }
    if (orders.size > 0) return { type: 'list', rows: [...orders].map(([number, photos]) => ({ go: String(number), thumbUrl: photos[0].thumbUrl, title: `Qimati${number}`, note: `${count(photos.length, 'photo')} · ${day(photos[0].at)}` })) }
    // A whole order number with no photograph can still be answered with its tracking number.
    return result.key.length >= 4 ? { type: 'order', number: Number(result.key), photos: [] } : { type: 'none', kind: 'order', key: result.key }
  }
  const codes = groupBy(result.photos, hit => hit.code), exact = codes.get(result.key)
  if (exact) return { type: 'product', code: result.key, photos: exact }
  if (codes.size === 1) return { type: 'product', code: result.photos[0].code, photos: result.photos }
  if (codes.size > 1) return { type: 'list', rows: [...codes].map(([code, photos]) => ({ go: code, thumbUrl: photos[0].thumbUrl, title: code, note: `${count(photos.length, 'raw photo')} · ${day(photos[0].at)}` })) }
  return { type: 'none', kind: 'product', key: result.key }
}
