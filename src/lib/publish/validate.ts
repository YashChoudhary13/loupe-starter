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
import { isControlledMaterial } from './description'
import type { PublishInput, PublishOptions } from './types'

/** The controlled material names a description can state. `316` alone counts as 316L. */
function materialsNamed(text: string): Set<string> {
  const found = new Set<string>()
  if (/\b316\s*L?\b/i.test(text)) found.add('316L')
  if (/\b304\b/.test(text)) found.add('304')
  if (/\bbrass\b/i.test(text)) found.add('Brass')
  return found
}

export type PublishBlockCode =
  | 'price_missing'
  | 'stock_zero'
  | 'variants_missing'
  | 'material_missing'
  | 'material_conflict'
  | 'weight_unknown'
  | 'tag_unconfirmed'
  | 'images_missing'

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
 * category default.
 *
 * `??` and not `||`, deliberately. NULL and 0 mean different things here:
 *
 *   NULL → "nobody has said."   Blocks publish.
 *   0    → "someone said zero." Publishes as 0 g.
 *
 * `||` would collapse the two and silently promote a deliberate 0 g on the draft
 * to whatever the category happened to carry. See docs/DECISIONS.md D19.
 */
export function resolveWeightG(input: PublishInput): number | null {
  return input.draft.weight_g ?? input.category.default_weight_g ?? null
}

/**
 * Option rows are the inventory source of truth. product_drafts.stock remains a
 * compatibility field for the pre-feature console, so it must never decide
 * whether a colour/number product is buyable.
 */
export function totalAvailableStock(input: PublishInput): number {
  return input.draft.variant_kind === 'none'
    ? input.draft.stock
    : input.variants.reduce((total, variant) => total + variant.stock, 0)
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

  if (totalAvailableStock(input) <= 0 && options.allowZeroStock !== true) {
    blocks.push({
      code: 'stock_zero',
      field: 'stock',
      message:
        `${draft.variant_kind === 'none' ? 'Stock' : 'Total choice stock'} is zero. ` +
        'Tick "publish with zero stock" if that is deliberate — ' +
        'a live product nobody can buy is usually a mistake, not a decision.',
    })
  }

  if (draft.variant_kind !== 'none' && input.variants.length === 0) {
    blocks.push({
      code: 'variants_missing',
      field: 'variants',
      message:
        draft.variant_kind === 'colour'
          ? 'Stock is set to “By colour”, but no colours have been added.'
          : draft.variant_kind === 'size'
            ? 'Stock is set to “By size”, but no ring sizes have been added.'
            : 'Stock is set to “Numbered choices”, but no numbered pieces have been added.',
    })
  }

  if (input.materialName === null) {
    blocks.push({
      code: 'material_missing',
      field: 'material',
      message:
        'No material. It supplies the first line of the product description and the ' +
        'custom.material metafield. Pick 304, 316L or Brass, or enter a custom material.',
    })
  }

  // The tag (card badge, 316L/304 collections), the custom.material metafield and
  // the SEO title all follow the selected material; a custom description that
  // names a different one ships a product whose badge contradicts its own text.
  // Found live on 22 products on 4 Sep 2026 (hand-made admin duplicates, but the
  // override path can produce the same thing).
  if (input.materialName && draft.description_override && isControlledMaterial(input.materialName)) {
    const named = materialsNamed(draft.description_override)
    const clean = input.materialName.trim().replace(/\s+/g, ' ')
    if (named.size > 0 && !(named.size === 1 && named.has(clean))) {
      blocks.push({
        code: 'material_conflict',
        field: 'description',
        message:
          `Material is ${clean}, but the custom description names ${[...named].join(' and ')}. ` +
          'The badge, collections and SEO title follow the material — make the text agree ' +
          'or switch back to the standard description.',
      })
    }
  }

  // NULL only. A category whose default is 0 publishes as 0 g, because somebody
  // chose that; a category whose default is NULL has simply never been asked.
  if (resolveWeightG(input) === null) {
    blocks.push({
      code: 'weight_unknown',
      field: 'weight',
      message:
        `Weight is unknown — neither this draft nor the ${category.name} category has one, ` +
        'and NULL means nobody has said rather than zero. Set categories.default_weight_g ' +
        '(0 is allowed and means a deliberate zero) or set the weight on this draft.',
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

  // Opt-OUT rather than opt-in. Every product Qimati sells exists because
  // somebody photographed it, so "no image" is a mistake unless a caller says
  // otherwise — and the only caller that does is the Phase 2 publish harness,
  // which has no photographs and is testing SKU behaviour.
  if (options.requireImages !== false && input.images.length === 0) {
    blocks.push({
      code: 'images_missing',
      field: 'images',
      message:
        'No image selected. Pick at least one version to publish — a listing with no ' +
        'photograph is the one thing a wholesale buyer cannot work around.',
    })
  }

  return blocks
}

export function assertPublishable(input: PublishInput, options: PublishOptions = {}): void {
  const blocks = validateDraftForPublish(input, options)
  if (blocks.length > 0) throw new PublishBlockedError(input.draft.id, blocks)
}
