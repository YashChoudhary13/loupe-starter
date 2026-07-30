/**
 * The "will publish as" preview.
 *
 * ⚠️ PREDICTION, NOT ALLOCATION. Nothing in this file touches a counter. The
 * authoritative number comes from `next_sku()` inside the publish transaction
 * and nowhere else (CLAUDE.md hard rule 1). Rendering this preview a thousand
 * times moves `sku_counters.last_number` exactly zero times.
 *
 * It exists because hard rule 8 requires the operator to see the resolved
 * `SKU · title · handle` before pressing Publish, so a wrong category is visible
 * *before* it becomes a product in the wrong collection with a number from the
 * wrong sequence.
 *
 * Because it is a prediction, it can be wrong in exactly one harmless way: if
 * somebody else publishes in the same category first, the real number is one
 * higher. It is never wrong about the prefix, the title pattern or the shape of
 * the handle — and `tests/publish-identity.test.ts` proves the formatting agrees
 * with the deployed database function for every configured category.
 */
import { formatSku, renderTitle, slugifyHandle } from '@/lib/publish/identity'

export interface PredictedIdentity {
  readonly sku: string
  readonly skuNumber: number
  readonly title: string
  readonly handle: string
  /** False once the draft carries a real reservation — then this is fact, not a guess. */
  readonly predicted: boolean
}

export interface IdentityPreviewInput {
  readonly skuPrefix: string
  readonly titlePattern: string
  /** `sku_counters.last_number` for this prefix. The next publish takes +1. */
  readonly lastNumber: number
  readonly titleSuffix: string | null
  /** Set once `reserve_draft_identity()` has run. Frozen; never re-derived. */
  readonly reservedSku: string | null
  readonly reservedHandle: string | null
}

export function predictIdentity(input: IdentityPreviewInput): PredictedIdentity {
  // The retry path. A reserved SKU and handle are the product's identity and are
  // reused verbatim — re-deriving the handle would make Shopify create a second
  // product (hard rule 2). The title is still re-rendered so a corrected
  // title_suffix shows up, which is exactly what the database does (D27).
  if (input.reservedSku && input.reservedHandle) {
    const number = Number.parseInt(input.reservedSku.replace(/^[A-Za-z]+/, ''), 10)
    return {
      sku: input.reservedSku,
      skuNumber: number,
      title: renderTitle(input.titlePattern, number, input.titleSuffix),
      handle: input.reservedHandle,
      predicted: false,
    }
  }

  const number = input.lastNumber + 1
  const title = renderTitle(input.titlePattern, number, input.titleSuffix)
  return {
    sku: formatSku(input.skuPrefix, number),
    skuNumber: number,
    title,
    handle: slugifyHandle(title),
    predicted: true,
  }
}
