/**
 * Rupees in, paise out — as a string transformation, never as arithmetic on a
 * float.
 *
 * `Math.round(parseFloat("75.55") * 100)` is 7555 today and is exactly the kind
 * of thing that is right until it is not: `parseFloat("8.115") * 100` is
 * 811.4999999999999. Money is paise (CLAUDE.md conventions), the operator types
 * rupees, and the only safe bridge between the two is splitting on the decimal
 * point and reading the digits.
 *
 * Deliberately strict about what it refuses, because every refusal here is a
 * price that would otherwise have gone to a live store:
 *
 *   ''          nothing typed
 *   '0'         hard rule 8 blocks a zero price
 *   '-75'       negative
 *   '75.555'    three decimals — paise do not divide further, and silently
 *               rounding somebody's price is worse than asking
 *   '7 5', 'ab' not a number
 */

export type PriceParse =
  | { readonly ok: true; readonly paise: number }
  | { readonly ok: false; readonly reason: string }

/** `₹`, spaces and thousands separators are noise; everything else must be a digit. */
const CLEANABLE = /[₹,\s]/g

export function parseRupeesToPaise(raw: string): PriceParse {
  const text = raw.replace(CLEANABLE, '')
  if (text === '') return { ok: false, reason: 'Enter a price.' }

  if (text.startsWith('-')) {
    return { ok: false, reason: 'A price cannot be negative.' }
  }

  if (!/^\d*(\.\d*)?$/.test(text) || text === '.') {
    return { ok: false, reason: 'Enter a price in rupees, like 75 or 75.50.' }
  }

  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > 2) {
    return {
      ok: false,
      reason: 'Rupees take at most two decimal places — 75.50, not 75.505.',
    }
  }

  const rupees = whole === '' ? 0 : Number.parseInt(whole, 10)
  const paise = fraction === '' ? 0 : Number.parseInt(fraction.padEnd(2, '0'), 10)

  if (!Number.isSafeInteger(rupees)) {
    return { ok: false, reason: 'That price is too large to be real.' }
  }

  const total = rupees * 100 + paise
  if (total <= 0) {
    return { ok: false, reason: 'Publish is blocked on a zero price.' }
  }

  return { ok: true, paise: total }
}

/** Paise → the rupee string an operator reads. `7550` → `75.50`, `7500` → `75`. */
export function formatPaiseForInput(paise: number | null): string {
  if (paise === null) return ''
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const rupees = Math.trunc(abs / 100)
  const fraction = abs % 100
  return fraction === 0 ? `${sign}${rupees}` : `${sign}${rupees}.${String(fraction).padStart(2, '0')}`
}

/** Paise → the display string, always with the symbol and always with paise. */
export function formatPaise(paise: number | null): string {
  if (paise === null) return '—'
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}₹${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
