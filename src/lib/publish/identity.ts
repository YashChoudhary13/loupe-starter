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
 * Zero-pads a number to a MINIMUM of three digits — `%03d`, not "exactly three":
 *
 *     4 → 004      87 → 087      221 → 221      970 → 970      1000 → 1000
 *
 * The minimum is the whole point. Postgres `lpad(n, 3, '0')` pads OR **truncates**
 * to exactly three, so `lpad('1000', 3, '0')` is `'100'` — which would have issued
 * the 1000th necklace SKU `NK100`, colliding with a necklace that already exists,
 * in a project whose premise is that `RS221` must never happen again. The SQL side
 * uses `public.pad_sku_number()`, which wraps the length in `greatest(3, …)`.
 *
 * `String.padStart` has never truncated, which is exactly why the two
 * implementations disagreed above 999 and nothing noticed. They are now one named
 * concept on each side, compared directly in tests/publish-identity.test.ts.
 */
export function padSkuNumber(number: number): string {
  return String(number).padStart(3, '0')
}

/**
 * The SKU: prefix plus the padded number. `AK011`, `RS221`, `NK970`.
 * `product_drafts.reserved_sku` is checked against `^[A-Z]{2,4}[0-9]{3,}$`, so
 * numbers past 999 simply get wider.
 */
export function formatSku(prefix: string, number: number): string {
  return `${prefix}${padSkuNumber(number)}`
}

/**
 * The category's pattern with `{n}` substituted, plus the optional free-text suffix.
 *
 * The title number is padded the same way the SKU's is — confirmed against the live
 * store: `Anklets 087 (Single Piece)`, `Nose Pin 004`, `Rings 221`, `Necklace 970`.
 * Note that some patterns already carry a parenthetical of their own, so a suffix is
 * appended after it rather than replacing it.
 */
export function renderTitle(
  titlePattern: string,
  number: number,
  titleSuffix?: string | null,
): string {
  const base = titlePattern.replaceAll('{n}', padSkuNumber(number))
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
