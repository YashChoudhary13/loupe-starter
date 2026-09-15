import { describe, expect, it } from 'vitest'
import { draftLabelCopies, nextLabelsPrinted } from '@/lib/labels/draft-print'

describe('draft label print offer', () => {
  it('prints the saved stock quantity, or one sample when stock is zero', () => {
    expect(draftLabelCopies(12)).toBe(12)
    expect(draftLabelCopies(1)).toBe(1)
    expect(draftLabelCopies(0)).toBe(1)
  })
  it('keeps label-not-printed until the operator chooses Print, not Cancel', () => {
    expect(nextLabelsPrinted(false, 'cancel')).toBe(false)
    expect(nextLabelsPrinted(false, 'print')).toBe(true)
    expect(nextLabelsPrinted(true, 'cancel')).toBe(true)
  })
})
