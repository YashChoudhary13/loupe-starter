/**
 * Phase 2 · success criterion 6 — publish is blocked on zero/empty price, and on
 * zero stock unless explicitly overridden.
 *
 * CLAUDE.md hard rule 8: "never block publish silently". Two properties follow,
 * and both are asserted here:
 *
 *   - every reason is reported together, not one at a time;
 *   - a blocked publish reserves nothing, so it burns no SKU number. That last one
 *     is checked against the real database in `tests/publish-identity.test.ts`,
 *     since it is a property of the transaction rather than of this function.
 */
import { describe, expect, it } from 'vitest'

import {
  PublishBlockedError,
  assertPublishable,
  resolveWeightG,
  validateDraftForPublish,
} from '@/lib/publish/validate'
import type { CategoryRow, DraftRow, PublishInput } from '@/lib/publish/types'

const CATEGORY: CategoryRow = {
  id: 'cat-1',
  name: 'Necklaces',
  sku_prefix: 'NK',
  title_pattern: 'Necklace {n}',
  shopify_tag: 'Necklace',
  default_weight_g: 25,
  default_stock: 10,
}

const DRAFT: DraftRow = {
  id: 'draft-1',
  category_id: 'cat-1',
  material_id: 'mat-1',
  title_suffix: null,
  price_paise: 75_000,
  weight_g: null,
  stock: 5,
  status: 'assembling',
  reserved_sku: null,
  reserved_handle: null,
  shopify_product_id: null,
}

function input(
  draft: Partial<DraftRow> = {},
  category: Partial<CategoryRow> = {},
  rest: Partial<Pick<PublishInput, 'materialName' | 'colours'>> = {},
): PublishInput {
  return {
    draft: { ...DRAFT, ...draft },
    category: { ...CATEGORY, ...category },
    // `in` rather than `??` — an explicit `materialName: null` is the case under
    // test, and `??` would quietly substitute the default and make it pass.
    materialName: 'materialName' in rest ? (rest.materialName ?? null) : '316L',
    colours: rest.colours ?? [],
  }
}

function codes(i: PublishInput, allowZeroStock = false): string[] {
  return validateDraftForPublish(i, { allowZeroStock }).map((b) => b.code)
}

describe('publish validation', () => {
  it('a complete draft has nothing blocking it', () => {
    expect(validateDraftForPublish(input())).toEqual([])
    expect(() => assertPublishable(input())).not.toThrow()
  })

  // ── price ────────────────────────────────────────────────────────────────
  it('blocks an EMPTY price', () => {
    expect(codes(input({ price_paise: null }))).toContain('price_missing')
  })

  it('blocks a ZERO price', () => {
    expect(codes(input({ price_paise: 0 }))).toContain('price_missing')
  })

  it('blocks a negative price', () => {
    expect(codes(input({ price_paise: -1 }))).toContain('price_missing')
  })

  it('accepts the smallest real price — 1 paisa is not "empty"', () => {
    expect(codes(input({ price_paise: 1 }))).not.toContain('price_missing')
  })

  // ── stock ────────────────────────────────────────────────────────────────
  it('blocks zero stock by default', () => {
    expect(codes(input({ stock: 0 }))).toContain('stock_zero')
  })

  it('allows zero stock when it is explicitly ticked', () => {
    expect(codes(input({ stock: 0 }), true)).not.toContain('stock_zero')
    expect(() => assertPublishable(input({ stock: 0 }), { allowZeroStock: true })).not.toThrow()
  })

  it('the override is opt-in — an absent option is not an override', () => {
    expect(() => assertPublishable(input({ stock: 0 }), {})).toThrow(PublishBlockedError)
    expect(() =>
      assertPublishable(input({ stock: 0 }), { allowZeroStock: false }),
    ).toThrow(PublishBlockedError)
  })

  // ── the other three ──────────────────────────────────────────────────────
  it('blocks a missing material — the description bullets render from it', () => {
    expect(codes(input({}, {}, { materialName: null }))).toContain('material_missing')
  })

  it('blocks a category whose Shopify tag is unconfirmed (this is Nose Pins)', () => {
    expect(
      codes(input({}, { name: 'Nose Pins', sku_prefix: 'NP', shopify_tag: null })),
    ).toContain('tag_unconfirmed')
  })

  // ── weight: NULL and 0 mean different things (D19) ───────────────────────
  it('blocks a weight nobody has set — NULL means unknown', () => {
    expect(codes(input({ weight_g: null }, { default_weight_g: null }))).toContain('weight_unknown')
  })

  it('does NOT block a weight of 0 — that is a deliberate value, not a gap', () => {
    // Every category's default is currently 0 so the test store can publish. It
    // reproduces the live store's broken weight-based shipping and must be replaced
    // before cutover, but it is a decision someone made, not a missing answer.
    expect(codes(input({ weight_g: null }, { default_weight_g: 0 }))).not.toContain('weight_unknown')
    expect(codes(input({ weight_g: 0 }))).not.toContain('weight_unknown')
    expect(validateDraftForPublish(input({ weight_g: null }, { default_weight_g: 0 }))).toEqual([])
  })

  it('takes the draft weight over the category default, and the default when absent', () => {
    expect(resolveWeightG(input({ weight_g: 40 }))).toBe(40)
    expect(resolveWeightG(input({ weight_g: null }))).toBe(25)
    expect(resolveWeightG(input({ weight_g: null }, { default_weight_g: null }))).toBeNull()
  })

  it('a deliberate 0 g on the draft is NOT overridden by the category default', () => {
    // `??` and not `||`. With `||`, a draft explicitly set to 0 g would silently
    // publish at the category's 25 g instead — the operator's decision discarded
    // because it happened to be falsy.
    expect(resolveWeightG(input({ weight_g: 0 }, { default_weight_g: 25 }))).toBe(0)
  })

  it('0 on the category is not treated as "no default" either', () => {
    expect(resolveWeightG(input({ weight_g: null }, { default_weight_g: 0 }))).toBe(0)
  })

  // ── the "never silently" part ────────────────────────────────────────────
  it('reports EVERY reason at once, not just the first', () => {
    const blocks = validateDraftForPublish(
      input(
        { price_paise: 0, stock: 0, weight_g: null },
        { default_weight_g: null, shopify_tag: null },
        { materialName: null },
      ),
    )

    expect(blocks.map((b) => b.code).sort()).toEqual([
      'material_missing',
      'price_missing',
      'stock_zero',
      'tag_unconfirmed',
      'weight_unknown',
    ])
  })

  it('each block names the field it is about, so the console can point at it', () => {
    const blocks = validateDraftForPublish(input({ price_paise: null, stock: 0 }))
    expect(blocks.every((b) => b.field.length > 0 && b.message.length > 0)).toBe(true)
    expect(new Set(blocks.map((b) => b.field))).toEqual(new Set(['price', 'stock']))
  })

  it('PublishBlockedError carries the blocks and lists them in its message', () => {
    const error = (() => {
      try {
        assertPublishable(input({ price_paise: null, stock: 0 }))
        return null
      } catch (e) {
        return e as PublishBlockedError
      }
    })()

    expect(error).toBeInstanceOf(PublishBlockedError)
    expect(error!.blocks).toHaveLength(2)
    expect(error!.message).toMatch(/price/)
    expect(error!.message).toMatch(/stock/)
  })
})
