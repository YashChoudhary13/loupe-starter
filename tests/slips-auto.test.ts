import { describe, expect, it } from 'vitest'
import { autoDue, istMinutes } from '@/lib/slips/auto'

describe('auto print cutoff', () => {
  it('prints before 4:30 PM IST, not from 4:30 on', () => {
    expect(autoDue(16 * 60 + 29)).toBe(true)
    expect(autoDue(16 * 60 + 30)).toBe(false)
    expect(autoDue(0)).toBe(true)
  })
  it('reads the IST clock', () => {
    expect(istMinutes(new Date('2026-10-20T11:00:00Z'))).toBe(16 * 60 + 30) // 11:00 UTC = 16:30 IST
    expect(istMinutes(new Date('2026-10-20T18:30:00Z'))).toBe(0) // midnight IST, never 24:00
  })
})
