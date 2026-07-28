# Progress log

This file is the project's memory. Sessions have no recollection of each other — this is the only reliable record of what exists.

**Read this first, every session. Append to it last, every session.** Newest entry at the top, directly under this template block.

---

## Entry template — copy this, fill it, put it at the top

```markdown
## YYYY-MM-DD — <Phase N: short title>

**Goal this session:** one sentence.

**Built:**
- file/module → what it does

**Verified:** which success criteria were met, and the evidence.
Paste actual output — test results, a real SKU that got created, a screenshot path.
"It ran" is not evidence.

**Not finished / known broken:**
- be specific — "grouping works but doesn't persist on refresh" beats "grouping WIP"

**Surprises:** anything that didn't behave as CLAUDE.md or the phase prompt described.
If a domain fact turned out wrong, fix CLAUDE.md in the same session and note it here.

**Next session should start with:** one concrete action.
```

---

## 2026-07-28 — Phase 2: the Shopify write path

**Goal this session:** the token manager, `seed:counters`, and `publishProduct()`.

**⚠️ PHASE 2 IS NOT COMPLETE.** Criteria 5 and 6 are met and demonstrated. Criteria 1–4
are **built, typechecked and blocked** on one external fact: the Shopify app is not
installed on `qimti.myshopify.com`, so no access token can be minted at all. See
*Blocked* below — it is a two-minute fix in the Shopify admin, and nothing else is
waiting on anything.

**Corrections applied first** (all six from the session prompt):

1. R2 bucket is **`loupe-image`** (singular), APAC. CLAUDE.md and D4 corrected; the
   Phase 0 `ENAM` note is closed.
2. `qimti.myshopify.com` is **correct**, and is the **test** store. Noted in CLAUDE.md
   so nobody "fixes" the spelling.
3. Hard rule 7 rewritten around the `client_credentials` grant.
4. D5 rewritten: OpenRouter route, **no dated pin**; the mitigation is that
   `image_versions` records `model` and `prompt_text` per row.
5. Parent `Qimati/CLAUDE.md` — **already absent** at session start. `find` over
   `/Users/yash/Desktop/Qimati` returns only the repo's own copy. Nothing to delete.
6. gmail `SEED_ADMIN_EMAIL` with no `ALLOWED_EMAIL_DOMAIN` recorded as **by design** in
   CLAUDE.md and in `.env.local.example`, not as an open question.

**Built:**

- `supabase/migrations/20260728140000_nose_pins_category.sql` → `shopify_tag` made
  nullable; **Nose Pins / `NP` / `Nose Pin {n}` with tag NULL** and its counter.
- `supabase/migrations/20260728140100_publish_functions.sql` → `raise_sku_counter()`,
  `reserve_draft_identity()`, `mark_draft_published()`, `mark_draft_failed()`. All
  four revoked from `anon`/`authenticated`, granted to `service_role`.
- `src/lib/shopify/token.ts` → the `client_credentials` token manager. Caches with the
  response's own expiry, refreshes 4 h early (≈20 h into a 24 h token), single-flights
  concurrent callers, and explains `app_not_installed` in English.
- `src/lib/shopify/client.ts` → GraphQL client. 401 → invalidate + retry **once**;
  429 / 5xx / `THROTTLED` → bounded backoff (0/1/3/8 s) then stop.
- `src/lib/shopify/product-set.ts` → `productSet` identified by handle, plus read-back,
  count-by-handle and delete helpers used for the evidence.
- `src/lib/shopify/config.ts`, `errors.ts` → config with API version pinned at
  `2026-07`; errors classified retryable/permanent at the point they are created.
- `src/lib/publish/{identity,validate,types,publish-product}.ts` → `publishProduct()`.
- `scripts/seed-counters.ts` → `npm run seed:counters [-- --dry-run]`.
- `scripts/verify-publish.ts` → `npm run verify:publish [-- --cleanup]`, criteria 1–4.
- `scripts/shopify-introspect.ts` → `npm run shopify:introspect`, dumps the
  `ProductSetInput` family so an API-version mismatch is a ten-second check.
- `scripts/verify-secret-isolation.ts` extended to scan client bundles for
  `SHOPIFY_CLIENT_SECRET` as well as the service-role key.
- `docs/phases/PHASE-2-shopify-write-path.md` → the phase spec, recorded.
- Tests: `shopify-token`, `shopify-client`, `publish-validation`, `publish-identity`;
  `rls.test.ts` and `schema.test.ts` extended.

**Verified:**

*Criterion 5 — the token refresh path, proven by test.* The clock is injected, so the
20-hour boundary is crossed in a millisecond. `stats().fetches` counts real calls to the
token endpoint.

```
✓ sends the client_credentials grant, not a static token
✓ caches: repeated calls inside the window hit the network once
✓ REFRESHES PROACTIVELY at ~20 h into a 24 h token — the criterion-5 assertion
✓ refreshes an already-expired token — inject one and watch it fetch
✓ computes the refresh point from the response, not from an assumption
✓ falls back to the documented 86399 s when Shopify omits expires_in
✓ invalidate() forces the next call to mint — this is the 401 path
✓ collapses concurrent callers onto ONE mint
✓ a failed mint does not poison the manager
✓ explains app_not_installed instead of reporting a bare 400
✓ classifies a 5xx as retryable and a bad secret as permanent
✓ on 401: invalidates, mints a NEW token and retries once
✓ on a second 401 it gives up rather than looping
✓ retries a 429 with bounded backoff, then succeeds
✓ treats a 200 carrying a THROTTLED extension as a rate limit, not a success
✓ stops after the retry budget instead of retrying forever
✓ does not retry a permanent GraphQL error
```

The three that carry the weight: *"REFRESHES PROACTIVELY at ~20 h"* asserts the old
token is still returned at 19 h and a **different** one at 20 h 01 m — a manager that
refreshed only on expiry passes every other test in this file and fails that one.
*"collapses concurrent callers onto ONE mint"* is what stops criterion 3's 20 parallel
publishes minting 20 tokens. *"on a second 401 it gives up"* asserts exactly two
attempts, not three and not forever.

*Criterion 6 — publish is blocked, and blocked loudly.*

```
✓ blocks an EMPTY price          ✓ blocks a ZERO price        ✓ blocks a negative price
✓ accepts the smallest real price — 1 paisa is not "empty"
✓ blocks zero stock by default   ✓ allows zero stock when it is explicitly ticked
✓ the override is opt-in — an absent option is not an override
✓ blocks a missing material — the description bullets render from it
✓ blocks a category whose Shopify tag is unconfirmed (this is Nose Pins)
✓ blocks an unknown weight rather than publishing 0 g
✓ reports EVERY reason at once, not just the first
✓ each block names the field it is about, so the console can point at it
```

And the property that matters more than the message — a blocked publish **burns no SKU
number**, asserted against the real database:

```
✓ BURNS NO NUMBER when the price is empty
✓ refuses a category whose Shopify tag is unconfirmed, and burns no number
```

*The publish transaction, against the deployed database.*

```
✓ agrees with the TypeScript preview for every category            4648ms
✓ moves the draft to publishing and writes an event                1373ms
✓ REUSES the identity on a second call and burns no second number  1663ms
✓ allocates DISTINCT consecutive numbers to concurrent reservations 1367ms
✓ raise_sku_counter: raises, and is idempotent                      971ms
✓ raise_sku_counter: NEVER lowers — the property seed:counters needs 1241ms
✓ raise_sku_counter: raises on an unknown prefix rather than inventing a sequence
```

*"agrees with the TypeScript preview for every category"* runs every seeded category
through both `reserve_draft_identity()` and `src/lib/publish/identity.ts` and compares
SKU, title and handle. Hard rule 8 requires the operator to see a resolved
`SKU · title · handle` before publishing; a preview that disagrees with what actually
gets written is worse than no preview, and two implementations of one rule drift.

*Nothing is reachable from a browser.* `rls.test.ts` now covers all four new functions:

```
✓ refuses an anonymous raise_sku_counter call
✓ refuses an anonymous reserve_draft_identity call
✓ refuses an anonymous mark_draft_published call
✓ refuses an anonymous mark_draft_failed call
✓ leaves the NK counter untouched after all of that
```

The last one is the point: the anonymous `raise_sku_counter('NK', 999999)` would have
been catastrophic had it gone through, so the test asserts the counter afterwards
rather than trusting the HTTP status.

*Whole suite:* `npm test` → **99 passed (99)**, 7 files, 46.08 s. `npm run typecheck`
clean. `npx eslint .` clean.

*The error path on the blocked criteria is itself demonstrated* — `seed:counters`
reaches Shopify and fails legibly rather than with a bare 400:

```
✗ Shopify refused to mint a token for qimti.myshopify.com: the app is not installed
  on this store.
  → The client_credentials grant only works once the app is installed. Open the app's
    install link from the Shopify admin (Settings → Apps and sales channels), or run
    `shopify app deploy` and install it on qimti.myshopify.com. SHOPIFY_CLIENT_ID must
    belong to that installed app.
```

**Blocked — criteria 1, 2, 3, 4 and the `seed:counters` run:**

The app whose `SHOPIFY_CLIENT_ID` is in `.env` (`36d3955a…`) is **not installed** on
`qimti.myshopify.com`. Probed directly:

```
GET  https://qimti.myshopify.com/            → 302 /password   (store exists, password-protected)
POST https://qimti.myshopify.com/admin/oauth/access_token
     grant_type=client_credentials           → 400  Oauth error app_not_installed
```

Tried as JSON and as form-encoded; same result. This is not a credential-format problem
— `client_credentials` only mints a token for an app that is **installed on that shop**.
Installing it requires a Shopify admin sign-in, so it is the operator's action, not one
this session can take.

Once it is installed, nothing else stands in the way:

```bash
npm run shopify:introspect          # confirm the ProductSetInput field names for 2026-07
npm run seed:counters -- --dry-run
npm run verify:publish
```

`verify:publish` runs criteria 1–4 end to end, asserts everything by **reading back from
Shopify** rather than trusting the mutation's reply, prints the product ID and the
`productsCount(query:"handle:…")` count, and tags everything `loupe-test`.

**Not finished / known broken:**

- **`SUPABASE_DB_PASSWORD` is still stale.** `npm run db:push` → `password
  authentication failed for user "postgres"`. Both Phase 2 migrations were applied
  through the Supabase Management API instead, and are recorded in
  `supabase_migrations.schema_migrations` as `20260728140000` / `20260728140100`, so
  `db:push` will report them already applied once the password is fixed. **`db:push` has
  still never been run successfully.**
- **`ProductSetInput` / `ProductVariantSetInput` field names are unverified against the
  live schema.** They were written from the API docs; `npm run shopify:introspect` exists
  precisely to check them and could not run. If `productSet` returns `userErrors` about
  an unknown field on the first real publish, that is why, and the introspect output says
  what to change.
- **`GOOGLE_SERVICE_ACCOUNT_JSON` in `.env` is unquoted multi-line JSON**, so dotenv
  parses it as `{` and shell `source` fails outright. Phase 3's problem, not touched
  here, but it will bite the moment Drive is wired up. Wrap it in single quotes or
  base64-encode it (`.env.local.example` already says base64).
- All `categories.default_weight_g` are still NULL, so **publish blocks on weight for
  every category** until real per-category grams arrive from the business (D19). The
  verify script sets weights on its own drafts to get around this.
- `NP` has no tag, so Nose Pins cannot publish. Deliberate (D23).
- The Supabase Storage bucket `images` still exists. Out of scope, destructive.

**Surprises:**

1. **The app is not installed** — the single blocker, above. Worth noting that the
   naive failure here is a bare `400` with an HTML body; the token manager pattern-matches
   `app_not_installed` and says what to do, which turned a confusing failure into an
   obvious one.
2. **`categories.shopify_tag` was `NOT NULL`,** so adding `NP` with an unconfirmed tag
   needed a schema change, not just an INSERT. Recorded as D23. The existing
   `CHECK (length(btrim(shopify_tag)) > 0)` still rejects `''` because a CHECK only
   fails on FALSE and evaluates to NULL here — so NULL means "unknown" and empty is
   still invalid, which is exactly the distinction wanted.
3. **A test helper using `??` gave a false pass.** `materialName: rest.materialName ??
   '316L'` meant the "blocks a missing material" case silently received `'316L'` and the
   test asserted nothing. Same family as Phase 1's `_isolation_probe_` false pass.
   Fixed with an `in` check. Two of these in two phases — when a negative test passes
   first time, check that it can fail.
4. **supabase-js types an embedded many-to-one as an array** but PostgREST returns an
   object. `loadPublishInput` accepts both rather than casting through `unknown` and
   being confidently wrong at runtime.
5. **`btrim(both '-' from …)` is not valid Postgres** — that is `trim`'s syntax.
   `btrim(str, '-')` is the two-argument form. Caught before deploy.

**Next session should start with:** install the Shopify app on `qimti.myshopify.com`,
then run `npm run shopify:introspect`, `npm run seed:counters -- --dry-run` and
`npm run verify:publish`, and paste the output into this entry. Phase 2 is not complete
until criteria 1–4 have real evidence.

---

## 2026-07-28 — Phase 1: foundation

**Goal this session:** repo scaffold, database schema, seed data and the atomic SKU counter.

**Built:**

- `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs` → Next.js 16.2.12 (App
  Router, Turbopack) · React 19.2.4 · TypeScript strict · Tailwind v4.
- `src/lib/env.ts` → server-only environment access. `import 'server-only'` on line 1.
- `src/lib/supabase/server.ts` → service-role client, server-only, bypasses RLS.
- `src/lib/supabase/browser.ts` → publishable-key client. Rejects anything not
  `sb_publishable_…`, so the legacy anon JWT or a pasted service-role key fails loudly.
- `src/lib/tables.ts` → the 13 table names, asserted against the live database by a test.
- `src/app/health/page.tsx` → `/health`, server-rendered, per-table row counts, IST timestamp.
- `src/app/globals.css` → the `docs/DESIGN.md` tokens. Tokens only; no component layer yet.
- `supabase/migrations/` → 14 migrations: 4 enum types + `app_role`, 13 tables, 48 indexes,
  `next_sku()`, RLS deny-all, seed, 2 test-support introspection functions.
- `scripts/db-push.ts`, `scripts/db-reset.ts` → migration runner and destructive re-apply.
- `scripts/seed-admin.ts` → idempotent `app_users` admin seed from `SEED_ADMIN_EMAIL`.
- `scripts/verify-secret-isolation.ts` → three-step proof for success criterion 5.
- `scripts/control-naive-counter.ts` + `tests/fixtures/naive-counter.sql` → the broken-counter
  control experiment.
- `tests/` → 44 tests across concurrency, schema invariants and RLS.
- `.gitignore` → `.env` and `.env.*` excluded **before** any file was written. Verified with
  `git check-ignore`.

**Verified:** all five success criteria met.

*Criterion 3 — 100 concurrent `next_sku('NK')` calls. The one that matters.*

```
  next_sku('NK') × 100, all in flight simultaneously
  ─────────────────────────────────────────────────────────────
  counter before          0
  counter after           100
  calls issued            100
  calls succeeded         100
  calls failed            0
  distinct values         100
  duplicates              none
  gaps in sequence        none
  range returned          1 … 100
  range expected          1 … 100
  peak concurrent calls   100   (1 would mean they queued, not raced)
  wall clock              952 ms
```

`peak concurrent calls = 100` is the part that makes this evidence rather than a coincidence:
all 100 requests were genuinely in flight at the same instant. Had they queued, a perfect
sequence would have proved nothing.

*The control — the same load against the implementation that caused `RS221`:*

```
SHIPPED  public.next_sku()  —  single UPDATE ... RETURNING
  distinct            100 / 100
  DUPLICATED numbers  none
  counter             0 → 100  (expected 100)
  VERDICT             SAFE — every product would get a unique SKU

CONTROL  public._loupe_naive_next_sku()  —  SELECT then UPDATE
  distinct            13 / 100
  DUPLICATED numbers  13 → 1, 10, 7, 5, 6, 2, 8, 3, 9, 4, 12, 11 …
  counter             0 → 13  (expected 100)
  numbers never issued 87
  VERDICT             BROKEN — this is how two products end up on RS221
```

87 of 100 products would have shipped on a duplicate SKU. The fixture was dropped from the
database afterwards, and `tests/schema.test.ts` fails if it is ever found present.

*Criterion 4 — unknown prefix raises:*

```
  next_sku('NOPE')
  HTTP status   400
  SQLSTATE      22023
  message       next_sku: unknown SKU prefix NOPE
  hint          Confirm the category against the live store, then add it to categories and sku_counters. Do not invent a prefix.
```

Asserted additionally that no `sku_counters` row was created for `NOPE` and that the `NK`
counter was untouched.

*Criterion 5 — service_role key unreachable from a client component:*

```
STEP 1 — control: a client component using the publishable key
  publishable key found in 1 client asset(s)
    e.g. .next/static/chunks/2duj-lha4uf3g.js
  control passes — the scan does see values that reach the browser ✓

STEP 2 — the same build must NOT contain the service_role key
  scanned 15 client asset(s) under .next/static
  service_role key: NOT PRESENT ✓

STEP 3 — a client component importing the server-only module must fail the build
  build FAILED, as required ✓
    Error: Turbopack build failed with 4 errors:
    You're importing a module that depends on "server-only".
    ./src/lib/supabase/server.ts [Client Component Browser]
```

The step-1 control matters: without it, "the key is not in the bundle" could just mean the
scan was looking in the wrong directory.

*Criterion 1 — `npm run dev` and `/health`:* `✓ Ready in 394ms`, `/health` → HTTP 200 in
2.49 s cold. Rendered: `categories 6 · sku_counters 6 · materials 3 · colours 0 ·
colour_usage 0 · product_drafts 0 · intake_files 0 · image_versions 0 · product_draft_images 0
· product_draft_variants 0 · prompts 0 · events 2 · app_users 1`. The service-role key does
not appear in the returned HTML.

*Criterion 2 — migrations against an empty database:* the `public` schema was verified empty
first (0 tables, 0 views, 0 functions, 0 enums, 0 recorded migrations). All 14 applied in
order in one pass → 13 tables, 48 indexes, 5 enums, RLS on all 13 with **0 policies**. The
seed migration was then re-run verbatim and counts were unchanged (6 / 3 / 6 / 1 seed event),
so it is idempotent.

*Whole suite:* `npm test` → **44 passed (44)**, 3 files, 21.14 s. `npx eslint .` clean.
`next build` clean.

**Not finished / known broken:**

- **`SUPABASE_DB_PASSWORD` in `.env` is stale.** It parses correctly (11 chars, ASCII) and is
  rejected with SQLSTATE `28P01` on all three routes: session pooler, transaction pooler and
  the direct host. Migrations were applied through the Supabase Management API instead.
  Consequence: **`npm run db:push` and `npm run db:reset` are written but have never been
  run.** Reset the password (Dashboard → Project Settings → Database), put it in `.env`, then
  run `npm run db:push` — it should report all 14 already applied.
- The same missing password blocks the strongest possible concurrency proof: holding a
  transaction open in one session and showing a second `next_sku` call *block* on the row
  lock. The 100-way test plus the naive control is strong evidence; that would be proof.
- All six `sku_counters.last_number` are **0 and wrong**. Publishing anything before Phase 2
  sets the true max per prefix would re-issue SKUs that already exist in the live store.
- `categories.default_weight_g` is NULL for all six — deliberately, so publish cannot inherit
  the live "weight 0 on every variant" bug by defaulting.
- The abandoned Supabase Storage bucket `images` **still exists** (Phase 0 said delete it).
  Out of Phase 1 scope and destructive, so left alone.
- 12 npm advisories, all dev/build toolchain (`eslint`→`brace-expansion`, `postcss` CSS
  stringifier, `sharp`/libvips). None in runtime domain code. `npm audit fix --force` would
  downgrade `next` and `eslint-config-next`; not worth it for a tool with no public surface.

**Surprises:**

1. **`.env` was empty at session start** and was populated mid-session. The file the phase
   prompt calls "a filled example in the repo root" is `../.env.local.example`, one level
   *above* the repo — a file named `…example` holding a live Shopify domain and Supabase
   URL. The real credentials are in `loupe-starter/.env`. Both are now gitignored;
   `.env.local.example` in the repo is a genuine no-values template.
2. **`.env` contradicts DECISIONS.md D5.** D5 settled on OpenAI `gpt-image-2` pinned to a
   dated snapshot. `.env` carries `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image`,
   `OPENROUTER_GEMINI_MODEL` **and** `OPENROUTER_OPENAI_IMAGE_MODEL=openai/gpt-image-2`. That
   is a live bake-off, not a settled decision. **Not reversed** — flagged for Phase 3.
3. **`.env` has no `ALLOWED_EMAIL_DOMAIN`, and `SEED_ADMIN_EMAIL` is a gmail.com address**
   (a personal gmail.com address). CLAUDE.md hard rule 7 says sign-in is restricted to the
   company domain. A strict `qimati.in` check in Phase 4 would lock out the only admin.
4. **`R2_BUCKET=loupe-image`** (singular) but CLAUDE.md and DECISIONS.md D4 both say
   `loupe-images` (plural). One is wrong; the Cloudflare dashboard decides.
5. **`SHOPIFY_STORE_DOMAIN=qimti.myshopify.com`** — "qimti", not "qimati". Possibly the real
   store handle, possibly a typo that will fail every API call in Phase 5.
6. **Shopify auth model differs.** `.env` has `SHOPIFY_AUTH_MODE=client_credentials` with a
   client id and secret; CLAUDE.md hard rule 7 describes a long-lived admin token.
7. **`/Users/yash/Desktop/Qimati/CLAUDE.md`** (the parent directory) is an older near-duplicate
   of this repo's CLAUDE.md and both auto-load. It states volume as "20–100 new products/day"
   where this one says "~300/month", and describes the image model as an open bake-off. Two
   auto-loaded files disagreeing on domain facts is a trap for a future session.
8. `next_sku` is correct on Supabase Postgres 17.6 under READ COMMITTED with no advisory lock
   and no retry loop — `UPDATE … RETURNING` re-evaluates against the newly committed row via
   EvalPlanQual. Confirmed empirically, not just assumed.
9. A first attempt at the criterion-5 proof gave a **false pass**: the probe route was named
   `__isolation_probe__`, and the App Router treats a leading-underscore folder as private and
   excludes it from routing, so the offending component was never bundled and the build
   "succeeded". Renamed to `isolation-probe`, after which it failed correctly. Worth
   remembering — a negative test that silently tests nothing is worse than no test.

**Next session should start with:** reset `SUPABASE_DB_PASSWORD` in the Supabase dashboard,
put it in `.env`, and run `npm run db:push` to confirm it reports all 14 migrations already
applied. Then `docs/phases/PHASE-2-*.md` — but Phase 2 is blocked on the true max SKU per
prefix, which still has to come from the Shopify products CSV.

---

## 2026-07-28 — Phase 0: setup (no code yet)

**Goal this session:** provision external services before any build work.

**Built:** nothing — infrastructure only.

**Verified / done:**
- Supabase project `qimati-loupe` created, region `ap-south-1` (Mumbai), status healthy. `public` schema is **empty** — migrations start clean from this repo.
- Cloudflare R2 bucket `loupe-images` created, private.
- Google Cloud project created, Drive API enabled, service account created.
- Naming scheme settled: everything is **Loupe** / `qimati-loupe` / `loupe-*`.
- Design direction settled — see `design/*.html` and `docs/DESIGN.md`.

**Not finished / known broken:**
- **R2 bucket location is `ENAM`** (Eastern North America) — it was created via API from a US host. Operators are in Jaipur and Vercel should run in Mumbai. Location hints cannot be changed after creation. **While the bucket is still empty, delete and recreate it in the Cloudflare dashboard with the Asia-Pacific hint.** Do this before Phase 3 writes anything to it.
- A Supabase Storage bucket named `images` was created early and then abandoned when the decision moved to R2. Delete it so nobody mistakes it for live.
- Shopify custom app: not yet created.
- OpenAI API key: not yet created.

**Blocking Phase 2 — must be collected from the business:**
- [ ] The exact enhancement prompt currently used in ChatGPT, verbatim, including any follow-up messages
- [ ] **True max SKU number per prefix** (`NK`, `ER`, `BK`, `CB`, `RS`, `AK`) — export products CSV from Shopify admin, split SKU into letters + number, take `MAX()` per prefix. **Use the max, not the row count** — the sequences have gaps.
- [ ] SKU prefix, title pattern and exact tag for the remaining categories: Watches, Hand Chains, Nose Pins, Jewellery Box, Bags, Hair Accessories, Indian Jewellery, Brass
- [ ] Default weight (grams) and default stock per category
- [ ] Confirm whether Shopify collections are automated by tag or curated manually

**Next session should start with:** `docs/phases/PHASE-1-foundation.md`. It needs none of the blocking items above.
