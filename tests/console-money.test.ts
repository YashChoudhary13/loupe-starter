/**
 * Phase 4 · criterion 7 — paise conversion is exact.
 *
 * Money is paise (CLAUDE.md conventions) and the operator types rupees, so this
 * parser is the bridge. It is string-based on purpose: the float route is right
 * often enough to ship and wrong often enough to matter —
 * `parseFloat('8.115') * 100` is 811.4999999999999.
 */
import { describe, expect, it } from 'vitest'

import { formatPaise, formatPaiseForInput, parseRupeesToPaise } from '@/lib/console/money'

function paise(input: string): number {
  const result = parseRupeesToPaise(input)
  if (!result.ok) throw new Error(`expected ${input} to parse: ${result.reason}`)
  return result.paise
}

describe('rupees → paise', () => {
  it('handles the prices Qimati actually sells at', () => {
    // docs/CONTEXT.md: "mostly priced around ₹75–₹750 per piece".
    expect(paise('₹75')).toBe(7_500)
    expect(paise('₹75.50')).toBe(7_550)
    expect(paise('₹750')).toBe(75_000)
  })

  it('accepts the shapes an operator types', () => {
    expect(paise('75')).toBe(7_500)
    expect(paise(' 75 ')).toBe(7_500)
    expect(paise('₹ 75')).toBe(7_500)
    expect(paise('1,250')).toBe(125_000)
    expect(paise('1,250.25')).toBe(125_025)
    expect(paise('75.5')).toBe(7_550) // one decimal is five-tenths of a rupee
    expect(paise('.5')).toBe(50)
    expect(paise('0.01')).toBe(1)
  })

  it('is exact where the float route drifts', () => {
    // `parseFloat('1.13') * 100` is 112.99999999999999 and
    // `parseFloat('8.11') * 100` is 810.9999999999999. Rounding hides it here
    // and stops hiding it somewhere less convenient, so the parser never
    // multiplies at all.
    expect(paise('1.13')).toBe(113)
    expect(paise('8.11')).toBe(811)
    expect(paise('4.35')).toBe(435)
    expect(paise('20.15')).toBe(2_015)

    // A three-decimal price is refused rather than rounded: silently turning
    // somebody's 75.505 into 75.50 or 75.51 is a decision Loupe does not get to
    // make on their behalf.
    expect(parseRupeesToPaise('8.115').ok).toBe(false)
  })

  it.each([
    ['', /Enter a price/],
    ['   ', /Enter a price/],
    ['0', /zero price/],
    ['0.00', /zero price/],
    ['-75', /cannot be negative/],
    ['75.505', /two decimal places/],
    ['1.005', /two decimal places/],
    ['abc', /rupees/],
    ['7 5x', /rupees/],
    ['75.5.5', /rupees/],
    ['.', /rupees/],
  ])('refuses %j', (input, reason) => {
    const result = parseRupeesToPaise(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  })

  it('refuses a number too large to be a real price', () => {
    const result = parseRupeesToPaise('9'.repeat(20))
    expect(result.ok).toBe(false)
  })
})

describe('paise → the operator', () => {
  it('round-trips through the input field without gaining or losing paise', () => {
    for (const value of [1, 50, 7_500, 7_550, 75_000, 125_025, 99]) {
      expect(paise(formatPaiseForInput(value))).toBe(value)
    }
  })

  it('drops a pointless .00 in the field but never in the display', () => {
    expect(formatPaiseForInput(7_500)).toBe('75')
    expect(formatPaiseForInput(7_550)).toBe('75.50')
    expect(formatPaiseForInput(null)).toBe('')

    expect(formatPaise(7_500)).toBe('₹75.00')
    expect(formatPaise(7_550)).toBe('₹75.50')
    expect(formatPaise(1)).toBe('₹0.01')
    expect(formatPaise(null)).toBe('—')
  })
})
