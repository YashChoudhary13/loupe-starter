/**
 * Refuse to write over a Shopify product Loupe did not create.
 *
 * `productSet` is addressed BY HANDLE — that is hard rule 2, and it is what
 * makes a retry update the half-published product instead of creating a twin.
 * The rule quietly assumes the product at that handle is OURS. Nothing enforced
 * it.
 *
 * On 2026-08-08 a hand-made `necklace-1007` sat at a handle Loupe then reserved.
 * `productSet` tried to reshape it and Shopify happened to refuse, because the
 * manual product carried a `Color` option linked to `shopify.color-pattern` that
 * cannot be swapped for the default `Title` option. That refusal is the only
 * reason the product survived: a plain hand-made product with no linked option
 * would have been overwritten — title, description, price, variants and images
 * replaced — and nothing would have said so.
 *
 * `shopify-numbering` makes the collision rare by stepping past occupied
 * numbers. This makes it HARMLESS, which is the part that matters. Prevention
 * that depends on a lookup a moment earlier is not enough on its own; a person
 * can always create a product in the seconds between.
 *
 * TELLING OUR PRODUCT FROM SOMEBODY ELSE'S
 *
 * Easy case: the draft records `shopify_product_id` and it matches. Ours.
 *
 * Hard case: the crash window. `productSet` succeeded, the process died before
 * the id was recorded, and the retry sees a product at our handle with no id on
 * file. Recovering from exactly that is a documented requirement, so this cannot
 * simply refuse whenever the id is missing.
 *
 * The discriminator is time. A product Loupe created FOR THIS DRAFT cannot
 * predate the draft row itself — Loupe did not know the number before then. So a
 * product at our handle created before `product_drafts.created_at` is
 * categorically not ours, whatever else it looks like. That test settles the
 * real case cleanly: the manual Necklace 1007 was created at 08:01:39 and the
 * draft at 08:42:38.
 *
 * A matching SKU is required as well. It is not sufficient on its own — the
 * hand-made product carried `NK1007` too, because whoever made it followed the
 * same numbering convention — but together with the timestamp it means the
 * product was created after we reserved and carries the number we reserved,
 * which no one else could have arranged by accident.
 */
import { ShopifyError } from '@/lib/shopify/errors'
import type { ProductReadback } from '@/lib/shopify/product-set'

export type HandleOwnership =
  /** Nothing at this handle. A normal create. */
  | { readonly kind: 'free' }
  /** The draft's recorded product. A normal update. */
  | { readonly kind: 'ours' }
  /** No id on file, but this can only be our own interrupted publish. */
  | { readonly kind: 'adopt'; readonly productId: string }
  /** Somebody else's product. Never write to it. */
  | { readonly kind: 'foreign'; readonly productId: string; readonly reason: string }

export interface OwnershipInput {
  readonly handle: string
  readonly reservedSku: string
  /** `product_drafts.shopify_product_id` — null before the first success. */
  readonly recordedProductId: string | null
  /** `product_drafts.created_at`. Our product cannot be older than this. */
  readonly draftCreatedAt: string
}

export function classifyHandleOwnership(
  input: OwnershipInput,
  existing: Pick<ProductReadback, 'id' | 'title' | 'variants'> & {
    readonly createdAt?: string | null
  } | null,
): HandleOwnership {
  if (!existing) return { kind: 'free' }

  if (input.recordedProductId && existing.id === input.recordedProductId) {
    return { kind: 'ours' }
  }

  if (input.recordedProductId && existing.id !== input.recordedProductId) {
    return {
      kind: 'foreign',
      productId: existing.id,
      reason:
        `the draft is recorded against ${input.recordedProductId}, but the handle now serves ` +
        `${existing.id} ("${existing.title}") — the product Loupe published was replaced`,
    }
  }

  // No id on file. Only an interrupted publish of THIS draft qualifies.
  const createdAt = existing.createdAt ? Date.parse(existing.createdAt) : Number.NaN
  const draftCreatedAt = Date.parse(input.draftCreatedAt)

  if (!Number.isFinite(createdAt)) {
    return {
      kind: 'foreign',
      productId: existing.id,
      reason: `a product already exists at this handle and Shopify reported no creation date for it`,
    }
  }
  if (createdAt < draftCreatedAt) {
    return {
      kind: 'foreign',
      productId: existing.id,
      reason:
        `"${existing.title}" was created in Shopify before this draft existed, so Loupe did not create it`,
    }
  }

  const carriesOurSku = existing.variants.nodes.some((variant) => variant.sku === input.reservedSku)
  if (!carriesOurSku) {
    return {
      kind: 'foreign',
      productId: existing.id,
      reason:
        `"${existing.title}" does not carry ${input.reservedSku}, so it is not this draft's product`,
    }
  }

  return { kind: 'adopt', productId: existing.id }
}

/**
 * Throws on a foreign product, with a message an operator can act on without
 * opening the code — hard rule 8: never block silently, and say what to do.
 */
export function assertHandleIsWritable(
  input: OwnershipInput,
  ownership: HandleOwnership,
): void {
  if (ownership.kind !== 'foreign') return

  throw new ShopifyError(
    `Refusing to publish: Shopify already has a different product at "${input.handle}" — ` +
      `${ownership.reason}.`,
    {
      kind: 'user_error',
      retryable: false,
      hint:
        `Nothing was changed in Shopify. If that product was listed by hand, this draft needs a ` +
        `different number: run Full reconciliation to move the counter past it, then re-group ` +
        `these photographs into a new draft. If it should be replaced, delete or rename it in ` +
        `Shopify admin first.`,
      detail: {
        handle: input.handle,
        reservedSku: input.reservedSku,
        existingProductId: ownership.productId,
        recordedProductId: input.recordedProductId,
      },
    },
  )
}
