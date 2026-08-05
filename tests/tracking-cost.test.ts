import { describe, expect, it } from 'vitest'

import { sumUsd, usd } from '@/lib/tracking/cost'

describe('tracking cost arithmetic', () => {
  it('parses PostgREST numeric strings without turning an unreadable figure into free', () => {
    expect(usd('0.076966')).toBe(0.076966)
    expect(usd(0.083)).toBe(0.083)
    // Nothing billed yet — absent, which the UI renders as no figure at all.
    expect(usd(null)).toBeNull()
    expect(usd(undefined)).toBeNull()
    // Unreadable must not become 0: that would under-report spend silently.
    expect(usd('not-a-number')).toBeNull()
    expect(usd(Number.NaN)).toBeNull()
    expect(usd(Number.POSITIVE_INFINITY)).toBeNull()
    // A real zero is a real figure and survives.
    expect(usd('0')).toBe(0)
  })

  it('sums exactly instead of accumulating float error', () => {
    // Naive float addition of these three gives 0.07362399999999999.
    expect(sumUsd([0.031205, 0.038945, 0.003474])).toBe(0.073624)
    // Real figures measured on 2026-08-05: a description plus one medium image.
    expect(sumUsd([0.031205, 0.076966])).toBe(0.108171)
  })

  it('distinguishes nothing-billed from billed-zero', () => {
    expect(sumUsd([])).toBeNull()
    expect(sumUsd([null, null])).toBeNull()
    // A provider that genuinely reported 0 is not the same as no call at all.
    expect(sumUsd([0])).toBe(0)
    expect(sumUsd([null, 0])).toBe(0)
  })

  it('ignores unbilled parts rather than discarding the whole total', () => {
    // One version with a missing cost must not void a draft's other real spend.
    expect(sumUsd([0.076966, null, 0.076966])).toBe(0.153932)
  })

  it('adds a multi-photograph draft the same way it adds one photograph', () => {
    // Two grouped photographs, each a description plus one generated image.
    const first = sumUsd([0.031205, 0.076966])
    const second = sumUsd([0.038945, 0.076966])
    expect(sumUsd([first, second])).toBe(0.224082)
  })
})
