# Phase 2 — the Shopify write path

Recorded from the session prompt of 2026-07-28 so the success criteria survive the
session. CLAUDE.md: *never mark a phase complete until every success criterion in
its prompt file has been met and demonstrated.*

**In scope:** the Shopify token manager, `npm run seed:counters`, `publishProduct()`.
**Out of scope:** Google Drive, R2, image enhancement, cron jobs, any UI. Do not build ahead.

---

## Corrections applied at the start of this phase

These were flagged as open questions by Phase 1 and are now resolved. They are
recorded here because a future session reading only the Phase 1 entry would still
think they were open.

1. **R2 bucket is `loupe-image` — SINGULAR.** `.env` was right; CLAUDE.md and D4 were
   stale. Verified against the live dashboard: name `loupe-image`, location APAC,
   created 28 Jul. This also closes the Phase 0 note about an `ENAM` bucket.
2. **`SHOPIFY_STORE_DOMAIN=qimti.myshopify.com` is CORRECT**, not a typo. Confirmed at
   `admin.shopify.com/store/qimti`. It is a **test store**; the live store is a later
   cutover.
3. **Shopify auth is the `client_credentials` grant**, not a static `shpat_` token.
   Hard rule 7 rewritten.
4. **D5: use the OpenRouter route, and do NOT pin a dated snapshot.** The mitigation
   for style drift is that `image_versions` records `model` and `prompt_text` on every
   row. D5 rewritten.
5. **Delete the parent-directory `Qimati/CLAUDE.md`** — it auto-loaded and contradicted
   this one.
6. **`SEED_ADMIN_EMAIL` on gmail with no `ALLOWED_EMAIL_DOMAIN` is BY DESIGN.** Not a
   bug. Authorisation is membership of `app_users`.

---

## 1. Shopify token manager

Auth is the client_credentials grant. It returns an offline token that expires in 24
hours (`expires_in: 86399`). Cache the token with its expiry, refresh proactively at
~20 hours, and treat a 401 as refresh-and-retry-once.

> This matters more than it looks: an implementation that fetches a token at boot
> passes every test today and silently stops publishing tomorrow. Write a test that
> proves the refresh path runs — inject an expired token and assert a new one is
> fetched.

## 2. `seed:counters` script

`npm run seed:counters` — read every product from the Shopify Admin API, extract the
SKU prefix and number, set `sku_counters.last_number` to the TRUE MAX per prefix.

- Idempotent, and it must **never lower** a counter. Only raise.
- `--dry-run` prints what it would set and changes nothing.
- Report prefixes found in Shopify that aren't in `categories`; don't invent rows.

A deliberate one-time seeding operation with the store quiet. It does **not**
contradict D2 — D2 forbids reading Shopify's max **at publish time**. That distinction
is now written into D2 so a future session doesn't "fix" this script.

Against the test store it will find almost nothing — that is the expected result. For
reference, the LIVE store's maxima are **NK 970 · ER 453 · BK 317 · CB 352 · RS 224 ·
AK 087**. Not hardcoded anywhere; a sanity check for cutover.

Also: the live store uses prefix **`NP`** for **Nose Pins**, title pattern
`Nose Pin {n}`. Added to `categories` with the **tag column null** (unconfirmed).

## 3. `publishProduct()`

Reserve SKU + handle inside one transaction using `next_sku()` → write the
`product_drafts` row as `publishing` → call `productSet` identified by **HANDLE** →
mark `published` with the Shopify id.

Must set: title (category pattern + number + optional suffix), handle, tag from the
category, `product_type` `Jewellery`, variant SKU, price from `price_paise`, stock,
weight, and the material as a **metafield** — not description HTML. Colour options
create variants that **share the parent SKU**.

Every state transition writes an `events` row.

---

## Success criteria — demonstrate each against the real test store

| # | Criterion |
|---|---|
| 1 | A product publishes and appears in the test store with correct title, handle, SKU, tag, product_type, price, stock, weight and material metafield. **Paste the Shopify product ID.** |
| 2 | **Idempotency:** publish twice with the same reserved handle. Assert exactly ONE product exists afterwards and the second call updated rather than duplicated. **Show the count query.** |
| 3 | **Concurrency:** publish 20 products in parallel. Assert 20 distinct consecutive SKUs and 20 distinct products in Shopify. No collisions. |
| 4 | **Failure:** simulate a failure between reserving the SKU and `productSet` succeeding. Assert the draft lands in `failed`, and that retrying reuses the SAME handle and produces one product. |
| 5 | Token refresh path proven by test. |
| 6 | Publish is blocked on zero/empty price and on zero stock unless explicitly overridden. |

Clean up the test products afterwards, or tag them `loupe-test` so they're findable.

**How they are demonstrated in this repo:**

- 5 and 6 — `npm test` (`tests/shopify-token.test.ts`, `tests/shopify-client.test.ts`,
  `tests/publish-validation.test.ts`). No network.
- 1–4 — `npm run verify:publish`, against the real store. Every assertion is a
  read-back from Shopify, never the mutation's own reply.
- Supporting: `tests/publish-identity.test.ts` proves the TypeScript preview and the
  deployed `reserve_draft_identity()` agree, and that a blocked publish burns no SKU.
