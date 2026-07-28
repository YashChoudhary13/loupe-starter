/**
 * SKU / title / handle formatting.
 *
 * ⚠️ These functions are a MIRROR of the logic inside
 * `public.reserve_draft_identity()`. The database is authoritative — the number
 * comes from `next_sku()` inside the publish transaction and nothing here can
 * allocate one (CLAUDE.md hard rule 1).
 *
 * They exist because hard rule 8 requires the console to show the operator a
 * resolved `SKU · title · handle` preview *before* they press Publish, so a wrong
 * category is visible. A preview that disagrees with what actually gets written
 * would be worse than no preview at all, so
 * `tests/publish-identity.test.ts` runs both implementations over the same inputs
 * and fails if they ever diverge.
 *
 * If you change one, change the other, and let that test tell you that you did.
 */

/**
 * Zero-padded to three digits, matching the live store: `AK011`, `RS221`, `NK970`.
 * Numbers past 999 simply get wider — `product_drafts.reserved_sku` is checked
 * against `^[A-Z]{2,4}[0-9]{3,}$`, which allows that.
 */
export function formatSku(prefix: string, number: number): string {
  return `${prefix}${String(number).padStart(3, '0')}`
}

/**
 * The category's pattern with `{n}` substituted, plus the optional free-text suffix.
 *
 * The number in the TITLE is deliberately NOT padded — the live store reads
 * "Rings 221", not "Rings 0221". Only the SKU is padded. Note that some patterns
 * already carry a parenthetical of their own (`Anklets {n} (Single Piece)`), so a
 * suffix is appended after it rather than replacing it.
 */
export function renderTitle(
  titlePattern: string,
  number: number,
  titleSuffix?: string | null,
): string {
  const base = titlePattern.replaceAll('{n}', String(number))
  const suffix = titleSuffix?.trim()
  return suffix ? `${base} ${suffix}` : base
}

/**
 * The Shopify handle, derived from the title.
 *
 * Frozen at first reservation and never recomputed, because it is the idempotency
 * key for `productSet` (hard rule 2). Retrying a failed publish must hit the same
 * handle or Shopify creates a second product.
 */
export function slugifyHandle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Splits a SKU into its prefix and number. Returns null for anything malformed. */
export function parseSku(sku: string): { prefix: string; number: number } | null {
  const match = /^([A-Za-z]{2,4})(\d{1,})$/.exec(sku.trim())
  if (!match) return null
  return { prefix: match[1].toUpperCase(), number: Number.parseInt(match[2], 10) }
}

/** Paise → the decimal rupee string Shopify's `MoneyInput` wants. Never a float. */
export function paiseToShopifyPrice(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new Error(`price_paise must be an integer, got ${paise}. Money is paise, never floats.`)
  }
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
