import { describe, expect, it } from 'vitest'

import { judgeMember, unsupportedRules, type MemberProduct, type RuleSet } from '@/lib/workflows/collection-rules'

const NECKLACES: RuleSet = {
  appliedDisjunctively: false,
  rules: [
    { column: 'TAG', relation: 'EQUALS', condition: 'Necklace' },
    { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' },
  ],
}

function member(overrides: Partial<MemberProduct>): MemberProduct {
  return {
    id: 'gid://shopify/Product/1',
    handle: 'necklace-1211',
    title: 'Necklace 1211',
    tags: ['necklace', 'NEWEST', '316L'],
    totalInventory: 12,
    maxPrice: 85,
    ...overrides,
  }
}

describe('collection rule evaluator (D122)', () => {
  it('passes a tagged, in-stock member (tags compare case-insensitively)', () => {
    expect(judgeMember(NECKLACES, member({}))).toEqual({ ok: true })
  })

  it('names a sold-out manual include in plain words', () => {
    expect(judgeMember(NECKLACES, member({ totalInventory: 0 }))).toEqual({ ok: false, reason: 'sold out' })
  })

  it('names a member whose category tag was removed', () => {
    expect(judgeMember(NECKLACES, member({ tags: ['earrings'] }))).toEqual({
      ok: false,
      reason: 'tag "Necklace" missing',
    })
  })

  it('handles the all-products price rule and the leftover rebuild marker', () => {
    const all: RuleSet = {
      appliedDisjunctively: false,
      rules: [
        { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' },
        { column: 'VARIANT_PRICE', relation: 'GREATER_THAN', condition: '0.0' },
        { column: 'TITLE', relation: 'NOT_CONTAINS', condition: 'zzqimatirebuild' },
      ],
    }
    expect(judgeMember(all, member({}))).toEqual({ ok: true })
    expect(judgeMember(all, member({ maxPrice: 0 })).ok).toBe(false)
    expect(unsupportedRules(all)).toEqual([])
  })

  it('refuses to judge a rule shape it does not understand', () => {
    const odd: RuleSet = {
      appliedDisjunctively: false,
      rules: [{ column: 'VENDOR', relation: 'EQUALS', condition: 'Qimati' }],
    }
    expect(unsupportedRules(odd)).toHaveLength(1)
  })
})
