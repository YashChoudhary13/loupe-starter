/**
 * What stops a publish, and why.
 *
 * CLAUDE.md hard rule 8 — "never block publish silently". Two things follow from
 * that, and both are the reason this returns a list rather than throwing on the
 * first problem:
 *
 *   - Every reason is reported at once. Telling an operator "no price", waiting
 *     for them to fix it, and then telling them "no material" is how a tool earns
 *     a reputation for wasting people's time.
 *   - Every reason carries the field it is about, so the console can point at it.
 *
 * The same invariants are enforced again inside `public.reserve_draft_identity()`.
 * That is not redundancy: these messages are for a person, those raises are for
 * anything that reaches the database without coming through here.
 */
import type { PublishInput, PublishOptions } from './types'

export type PublishBlockCode =
  | 'price_missing'
  | 'stock_zero'
  | 'material_missing'
  | 'weight_unknown'
  | 'tag_unconfirmed'

export interface PublishBlock {
  readonly code: PublishBlockCode
  readonly field: string
  readonly message: string
}

export class PublishBlockedError extends Error {
  readonly blocks: readonly PublishBlock[]

  constructor(draftId: string, blocks: readonly PublishBlock[]) {
    super(
      `Publish blocked for draft ${draftId}:\n` +
        blocks.map((b) => `  · ${b.field} — ${b.message}`).join('\n'),
    )
    this.name = 'PublishBlockedError'
    this.blocks = blocks
  }
}

/**
 * The weight a variant will be published with: the draft's own, else the
 * category default. `null` means neither is known, which is a block — see below.
 */
export function resolveWeightG(input: PublishInput): number | null {
  return input.draft.weight_g ?? input.category.default_weight_g ?? null
}

export function validateDraftForPublish(
  input: PublishInput,
  options: PublishOptions = {},
): readonly PublishBlock[] {
  const blocks: PublishBlock[] = []
  const { draft, category } = input

  if (draft.price_paise === null || draft.price_paise <= 0) {
    blocks.push({
      code: 'price_missing',
      field: 'price',
      message:
        draft.price_paise === null
          ? 'No price set. Publish is blocked on an empty price.'
          : `Price is ${draft.price_paise} paise. Publish is blocked on a zero price.`,
    })
  }

  if (draft.stock <= 0 && options.allowZeroStock !== true) {
    blocks.push({
      code: 'stock_zero',
      field: 'stock',
      message:
        'Stock is zero. Tick "publish with zero stock" if that is deliberate — ' +
        'a live product nobody can buy is usually a mistake, not a decision.',
    })
  }

  if (input.materialName === null) {
    blocks.push({
      code: 'material_missing',
      field: 'material',
      message:
        'No material. The six description bullets render from the material metafield, ' +
        'so publishing without one ships a product with no description (docs/DECISIONS.md D6). ' +
        'Pick 304, 316L or Brass.',
    })
  }

  if (resolveWeightG(input) === null) {
    blocks.push({
      code: 'weight_unknown',
      field: 'weight',
      message:
        `Weight is unknown — neither this draft nor the ${category.name} category has one. ` +
        'Publishing 0 g is what the live store already does, which is why weight-based ' +
        'shipping does not work there. Set categories.default_weight_g or the draft weight.',
    })
  }

  if (category.shopify_tag === null || category.shopify_tag.trim() === '') {
    blocks.push({
      code: 'tag_unconfirmed',
      field: 'category',
      message:
        `The ${category.name} category (${category.sku_prefix}) has no confirmed Shopify tag. ` +
        'Collections are tag-driven, so guessing one publishes the product straight out of ' +
        'its collection without any error. Read the tag off a live product and set it.',
    })
  }

  return blocks
}

export function assertPublishable(input: PublishInput, options: PublishOptions = {}): void {
  const blocks = validateDraftForPublish(input, options)
  if (blocks.length > 0) throw new PublishBlockedError(input.draft.id, blocks)
}
