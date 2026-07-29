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

## 2026-07-29 — Phase 3A complete: Drive intake survives watcher downtime

**Goal this session:** build and prove a durable Google Drive intake loop whose database
truth survives duplicate delivery, concurrent workers and watcher downtime.

**✅ PHASE 3A IS COMPLETE.** All eight success criteria were demonstrated against the
deployed application, real Drive folder and linked Supabase database. No file was moved to
Processed.

**Prerequisites proved before implementation:**

```text
$ supabase db push --linked --dry-run
Connecting to remote database...
Remote database is up to date.

GET https://qimati-loupe.vercel.app/health
health_status: 200
database_reachable: true
google_service_account_valid: true
```

**Built:**

- `supabase/migrations/20260729120000_phase_3a_intake_queue.sql` → `sync_state`,
  `next_attempt_at`, Drive metadata, queue indexes, idempotent discovery, `SKIP LOCKED`
  claims, bounded retries, expired-lease sweep, events, `pg_cron` and `pg_net`.
- `20260729121000_phase_3a_pg_net_schema.sql`,
  `20260729122000_harden_updated_at_search_path.sql`,
  `20260729123000_intake_lease_ownership.sql` → Supabase extension layout,
  trigger-function hardening and UUID compare-and-swap ownership for intake workers.
- `20260729124000_intake_size_limit_decimal_mb.sql` → corrects the literal phase limit
  forward to exactly 50,000,000 bytes; no applied migration was rewritten.
- `src/lib/google/drive-*` → server-only Drive v3 reader with service-account auth,
  exact Drive scope, pagination and readable error classification.
- `src/lib/intake/*` → insert-first discovery, full reconcile, race-safe change-token
  bootstrap/replay, repository boundary and lease sweep.
- `src/app/api/cron/{watch,reconcile,sweep}/route.ts` + `src/lib/cron/*` → POST-only,
  timing-safe bearer authentication and consistent job responses.
- `scripts/configure-cron.ts` → stores the production origin and 64-hex-character secret
  in Supabase Vault, then repeatably provisions the three named schedules.
- `scripts/verify-drive-intake-live.ts` → destructive, uniquely prefixed acceptance proof.
  Owner-uploaded fixtures stay under paused schedules until the service account verifies
  their exact Drive IDs are gone; database cleanup is transactional and happens before
  schedules resume.
- 49 Phase 3A assertions across route, Drive client, watch/reconcile and deployed SQL tests;
  schema/RLS coverage and client-bundle secret isolation now include the new table/secrets.

**Verified — the eight live success criteria:**

1. **Exactly 12 real Drive files became 12 `discovered` rows with matching metadata.**

```text
Criterion 1 PASS — exactly 12 discovered rows; Drive metadata matches:
loupe-phase3a-live-20260729-01.png  b182d83f290a78c665e85f1610985c8f  42  discovered
loupe-phase3a-live-20260729-02.png  efcfee8de21507e66c2bdbbba4eab6cc  42  discovered
loupe-phase3a-live-20260729-03.png  3473b7d4226f4d415785b2c45ef82f61  42  discovered
loupe-phase3a-live-20260729-04.png  13b7d97a93506ff67c672003190bf38f  42  discovered
loupe-phase3a-live-20260729-05.png  77d84dd44857b775f7b3a2a8a080e9ed  42  discovered
loupe-phase3a-live-20260729-06.png  ee0cd076ad5f1eba7f14b9cf71a7e62d  42  discovered
loupe-phase3a-live-20260729-07.png  2a18e22372b596a17763d6c617ced8f1  42  discovered
loupe-phase3a-live-20260729-08.png  bdb20702eab52f5cb3231900f42c3727  42  discovered
loupe-phase3a-live-20260729-09.png  66f37141c304dd6cc0e6974167b169b5  42  discovered
loupe-phase3a-live-20260729-10.png  20654f30c48bdbc5bb189c2905da3d4c  42  discovered
loupe-phase3a-live-20260729-11.png  647360d50b1cb6a44deee0cede5f9ac1  42  discovered
loupe-phase3a-live-20260729-12.png  b1afa10083b7721a8ae31906d5d49378  42  discovered
```

2–6. **Replay, reconcile, outage recovery, sweep and permanent failure all passed.**

```text
Criterion 2 PASS — immediate watch replay inserted 0 and mutated 0 rows
Criterion 3 PASS — exactly 3 deleted rows returned; the other 9 were byte-for-byte unchanged
Criterion 4 PASS — schedules stopped; file stayed absent for 70s; reconcile recovered
                   exactly 1 discovered row
Criterion 5 PASS — loupe-phase3a-live-20260729-01.png returned to discovered;
                   exactly 1 intake.lease_expired event added
Criterion 6 PASS — status=failed, class=permanent, attempts=1
  readable reason: The file format is text/plain. Loupe can enhance JPEG, PNG or
                   WebP images. Export it in one of those formats and try again.
  raw detail retained separately:
                   {"allowed": ["image/jpeg", "image/png", "image/webp"],
                    "mime_type": "text/plain"}
```

Criterion 4 deliberately paused **all three schedules**, uploaded the outage file, waited
70 seconds (longer than the one-minute watcher interval), proved no row existed, then ran
full reconcile. That is the actual evidence that a server outage cannot silently lose a
photographer's shoot.

7. **All schedules are active, all latest runs succeeded, and pg_net received 200s.**

```text
job 7  loupe-drive-reconcile  */15 * * * *  active=true  latest=succeeded  return="1 row"
job 8  loupe-drive-watch      * * * * *     active=true  latest=succeeded  return="1 row"
job 9  loupe-intake-sweep     */5 * * * *   active=true  latest=succeeded  return="1 row"

net._http_response, last 10 minutes:
responses=13  successful=13  min_status=200  max_status=200
```

8. **Every endpoint failed closed without the shared secret.**

```text
POST /api/cron/watch      → 401
POST /api/cron/reconcile  → 401
POST /api/cron/sweep      → 401
```

**Final cleanup and quality evidence:**

```text
Raw folder active children: 0
Prefixed live-test intake rows: 0

Test Files  13 passed (13)
Tests       171 passed (171)

Post-50-MB forward-migration check:
Test Files  2 passed (2)
Tests       35 passed (35)

typecheck: passed
lint: passed
next build: passed — /api/cron/watch, /reconcile and /sweep are dynamic routes
verify:isolation: service_role, Shopify secret, Google credential and CRON_SECRET absent
                  from all 15 client assets; server-only negative-control build failed
                  as required

supabase db push --linked --dry-run:
{"upToDate":true,"dryRun":true,"migrations":[]}

supabase db lint --linked --level warning:
No schema errors found
```

Production: `https://qimati-loupe.vercel.app` is READY and `/health` reports the database
reachable plus the validated service-account identity.

**Not finished / known broken:**

- Phase 3B/4 work remains intentionally out of scope: image enhancement, OpenRouter/OpenAI,
  R2, thumbnails, duplicate detection, Drive housekeeping and UI.
- The live harness needs an authorised user to upload/trash fixtures in a My Drive folder;
  the production service account can read them but Google gives service accounts no personal
  Drive storage quota.
- `npm audit --omit=dev` still reports three high findings in the existing
  Next/PostCSS/Sharp chain. Its proposed forced fix is a breaking downgrade to Next 9.
  The new Google dependency's vulnerable transitive `rimraf` chain was removed with a
  narrow override.

**Surprises:**

- `pg_cron` and `pg_net` installed successfully without a dashboard intervention.
  Supabase placed `pg_net` outside its expected `extensions` schema initially, so a forward
  migration moved it before job provisioning.
- A lease deadline alone did not prevent a stale worker overwriting its replacement.
  UUID ownership tokens were added in a forward migration and hard rule 6 in `CLAUDE.md`
  was corrected.
- Google service accounts cannot create acceptance fixtures in shared My Drive folders
  because they have no storage quota. The equivalent owner-upload path is D32.
- The Vercel project had a stale `public` output-directory setting; correcting it to the
  Next.js default made the server routes deploy.
- Independent review caught the initial binary interpretation of “50 MB” and an
  owner-cleanup race. Both were corrected before completion: the live limit is exactly
  50,000,000 bytes, and source deletion is now verified before test rows or schedules move.

**Next session should start with:** define Phase 3B's worker completion path around the
existing UUID claim token, keeping the original Drive file immutable and the database as
the only processing truth.

## 2026-07-29 — Phase 2 complete: all six criteria demonstrated against the test store

**Goal this session:** apply three decisions, add the Drive-credential validator, and
finish the Phase 2 verification now that the Shopify app is installed.

**✅ PHASE 2 IS COMPLETE.** All six success criteria in
`docs/phases/PHASE-2-shopify-write-path.md` are met and demonstrated. Evidence below.

**Decisions applied:**

1. **D19 — weight.** `default_weight_g = 0` for every category; publish passes on 0.
   NULL still means *unknown* and still blocks; the guard is kept, narrowed. CHECKs
   relaxed `> 0` → `>= 0` so both states stay expressible. ⚠️ **Real per-category
   weights are now on the blocking list below** — 0 g reproduces the live store's
   broken weight-based shipping.
2. **D20 — title numbers padded**, `%03d`, minimum three digits, no truncation:
   `4 → "Nose Pin 004"`, `87 → "Anklets 087 (Single Piece)"`, `221 → "Rings 221"`,
   `970 → "Necklace 970"`.
3. **D21 — `custom.material` reclassified** from "assumption to verify" to **defined
   interface**. The live store has no material metafield at all, so there is nothing to
   match; the only requirement is that the theme later reads the same `namespace.key`.

**Built:**

- `supabase/migrations/20260729100000_weight_zero_is_deliberate.sql`
- `supabase/migrations/20260729100100_pad_title_numbers.sql` → `pad_sku_number()` and a
  re-emitted `reserve_draft_identity()`.
- `src/lib/google/service-account.ts` + `tests/google-service-account.test.ts` (18 tests)
  → validates `GOOGLE_SERVICE_ACCOUNT_JSON` and names *which* mistake was made.
  `/health` now renders the result.
- `npm run verify:publish -- --cleanup-all` added; `--cleanup` now sweeps debris from
  *previous* runs too and deliberately **keeps** criterion 1's product.

---

### 🐛 Two real bugs found, both by doing the verification rather than by reading

**1. `lpad` truncates — this one was a latent SKU collision.**

Postgres `lpad(text, 3, '0')` pads *or truncates* to exactly three characters:

```
lpad('87',   3, '0')  →  '087'    ✓
lpad('1000', 3, '0')  →  '100'    ✗ silently loses a digit
```

`reserve_draft_identity()` used it directly for the SKU. The 1000th necklace would have
been issued **`NK100`** — colliding with a necklace that already exists, silently, in the
one project that exists because two products ended up on `RS221`. TypeScript's
`padStart` never truncates, so the two implementations also disagreed above 999 and the
test comparing them only ever ran two-digit counters through the database.

Fixed with `public.pad_sku_number()` = `lpad(n, greatest(3, length(n)), '0')`, mirrored by
`padSkuNumber()`, compared directly across `1, 4, 87, 99, 100, 221, 970, 999, 1000, 1234,
12345`, plus an end-to-end reservation that crosses 999:

```
✓ pad_sku_number() and padSkuNumber() agree, including above 999
✓ crosses 999 without losing a digit — the regression that bug would have caused
```

**2. `productSet` requires `productOptions` whenever `variants` are supplied.**

```
input.productOptions: Product options input is required when updating variants
```

A colourless product omitted the field and passed `optionValues: []`. **Every colourless
publish failed** — which is most of them. Criterion 1 did not catch it, because that draft
has Gold and Silver; criterion 3 caught it, with all 20 concurrent publishes failing
identically. Fixed by declaring Shopify's own `Title` / `Default Title` pair (D25).

Worth recording: both bugs were invisible to typecheck, lint and 122 passing tests. The
first needed a counter above 999, the second needed a product without colours. Neither
existed until the verification script created them.

**3. A frozen identity did not pin its category** — found by an adversarial review pass
over the diff, not by a test.

The identity is frozen on first reservation (hard rule 2) but the title and tag are
re-read from the draft's *current* category on every call, so that a corrected
`title_suffix` reaches the retry. If the category itself changed in between:

```
1. reserved as Necklaces  →  NK005 · "Necklace 005" · necklace-005
2. publish fails
3. operator realises it is a ring, switches the category
4. retry →  SKU NK005 · title "Rings 005" · tag Rings · handle necklace-005
```

A ring in the Rings collection carrying a number from the **necklace** sequence, at
`/products/necklace-005`, while `RS005` stays free for a real ring later. Nothing errors.
Phase 2 cannot reach this — nothing here edits `category_id` — but the console that will
is Phase 4/5. Guard added now, in the function that must enforce it (D27), with tests
both ways: the category change is refused by name, and a corrected suffix still publishes
on the same frozen handle.

```
✓ REFUSES a retry whose category changed under a frozen identity
✓ still allows a retry that only corrects the title suffix
```

---

### Evidence

*`npm run shopify:introspect` — every input field used by `product-set.ts` confirmed
against the live 2026-07 schema.*

```
shop "Qimti" · qimti.myshopify.com · USD · default weight POUNDS · 19 product(s)

ProductSetInput          handle, title, productType, tags, status, metafields,
                         productOptions, variants                              ✓ all present
ProductVariantSetInput   sku, price, position, taxable, optionValues,
                         inventoryItem, inventoryQuantities                     ✓ all present
ProductSetIdentifiers    id, handle, customId                                   ✓ handle
ProductSetInventoryInput locationId: ID!, name: String!, quantity: Int!         ✓
InventoryItemInput       sku, tracked, measurement                              ✓
WeightInput              value: Float!, unit: WeightUnit!                       ✓ GRAMS
MetafieldInput           namespace, key, value, type                            ✓
```

Note the shop's default weight unit is **POUNDS** and its currency is **USD** — test-store
settings. Loupe sends `unit: GRAMS` explicitly, so the readback reports GRAMS regardless.
Currency will need checking at cutover; the live store is INR.

*`npm run seed:counters -- --dry-run` — exactly the predicted result: almost nothing.*

```
  28 variants · 0 distinct SKU prefix(es) · 23 blank SKU(s) · 5 unparseable

  prefix  category              counter  shopify max   action
  NK      Necklaces                   0            —   nothing in Shopify — leave at 0
  ER      Earrings                    0            —   nothing in Shopify — leave at 0
  BK      Kada Bracelets              0            —   nothing in Shopify — leave at 0
  CB      Chain Bracelets             0            —   nothing in Shopify — leave at 0
  RS      Rings                       0            —   nothing in Shopify — leave at 0
  AK      Anklets                     0            —   nothing in Shopify — leave at 0
  NP      Nose Pins                   0            —   nothing in Shopify — leave at 0

UNKNOWN PREFIXES — present in Shopify, absent from `categories`
  none

UNPARSEABLE SKUs — not <letters><digits>, so no prefix could be read
  sku-untracked-1          "The Inventory Not Tracked Snowboard"
  sku-hosted-1             "The 3p Fulfilled Snowboard"
  sku-managed-1            "The Multi-managed Snowboard"
  NECK-227526              "Necklace 227526"
  TEST-001                 "TEST 001"
```

The five unparseable SKUs are **reported, not silently dropped** — `NECK-227526` and
`TEST-001` are hand-made products whose SKUs do not fit `<letters><digits>`. The apply
run then correctly did nothing: *"Nothing to do — every counter is already at or above
the Shopify max."*

*`npm run verify:publish` — criteria 1, 2, 3, 4 and 6, every assertion a **read-back from
Shopify** rather than the mutation's own reply.*

**Criterion 1 — `gid://shopify/Product/8032332283987`** (kept, live, tagged `loupe-test`):

```
  published    NK090 · Necklace 090 (Light Rose gold) · necklace-090-light-rose-gold
  ✓ the product exists in the store
  ✓ id                    gid://shopify/Product/8032332283987
  ✓ title                 Necklace 090 (Light Rose gold)
  ✓ handle                necklace-090-light-rose-gold
  ✓ product_type          Jewellery
  ✓ status                ACTIVE
  ✓ tags                  ["Necklace","loupe-test"]
  ✓ material metafield    316L
  variants  [{"sku":"NK090","price":"750.00","colour":"Gold","stock":12,"weight":"28 GRAMS"},
             {"sku":"NK090","price":"750.00","colour":"Silver","stock":12,"weight":"28 GRAMS"}]
  ✓ variant count 2 · ✓ every variant SHARES the SKU ["NK090","NK090"]
  ✓ colours ["Gold","Silver"] · ✓ price · ✓ weight · ✓ stock
  ✓ draft status published · ✓ draft carries the product id · ✓ published_at is set
  ✓ events                ["publish.reserved","publish.published"]
```

Note the title: **`Necklace 090`**, padded, and the handle derived from it. Independently
re-queried after the run — `products(query:"tag:loupe-test")` returns exactly one product,
that one.

**Criterion 2 — idempotency, with the count query:**

```
  count query  productsCount(query: "handle:necklace-090-light-rose-gold")
  ✓ reused the reserved identity   true
  ✓ same SKU / same handle / SAME Shopify product id
  ✓ no SKU number was burnt        90
  ✓ products in the store with this handle    1
```

**Criterion 3 — 20 parallel publishes:**

```
  wall clock   2099 ms
  ✓ publishes issued                 20
  ✓ publishes succeeded              20
  ✓ DISTINCT SKUs                    20
  ✓ SKUs are consecutive             [68,69,…,87]
  ✓ counter moved by exactly N       20
  ✓ DISTINCT Shopify product ids     20
  ✓ token fetches during the burst   0
  ✓ every handle maps to exactly one product  [1]
```

`token fetches during the burst = 0` is the single-flight token manager doing its job —
20 concurrent publishes, zero extra token mints.

**Criterion 4 — failure, both orderings:**

```
  4a — the call never reached Shopify
  ✓ draft status failed · ✓ the error was recorded
  ✓ reserved_sku was KEPT   NK088 · ✓ reserved_handle was KEPT   necklace-088
  ✓ nothing was published            null
  ✓ no product exists for that handle  0
  ✓ events   ["publish.reserved","publish.failed"]

  4a — the retry
  ✓ retry reused the SAME handle     necklace-088
  ✓ retry reused the SAME SKU        NK088
  ✓ the retry burnt no new number    88
  ✓ exactly ONE product exists       1

  4b — Shopify succeeded, we never recorded it
  ✓ recovery hit the same handle · ✓ same product id · ✓ STILL exactly one product  1
```

4b is the ordering that actually creates duplicates in the wild — a crash *after*
`productSet` returned but before the draft was marked published.

**Criterion 5 — token refresh**, and **criterion 6 — blocking**, by test (18 + 18 + 7):

```
✓ REFRESHES PROACTIVELY at ~20 h into a 24 h token — the criterion-5 assertion
✓ collapses concurrent callers onto ONE mint
✓ on 401: invalidates, mints a NEW token and retries once
✓ on a second 401 it gives up rather than looping
✓ blocks an EMPTY price · ✓ blocks zero stock by default
✓ allows zero stock when it is explicitly ticked
✓ does NOT block a weight of 0 — that is a deliberate value, not a gap
✓ a deliberate 0 g on the draft is NOT overridden by the category default
```

Criterion 6 end to end, where the database turned out to be stricter than the code:

```
  ✓ a zero price is not even STORABLE   [23514]
  ✓ empty price is blocked         [price_missing]   ✓ …and reserves nothing   null
  ✓ zero stock is blocked          [stock_zero]      ✓ …and reserves nothing   null
  ✓ zero stock publishes when explicitly overridden   NK112
  ✓ only the override burnt a number   112
```

`price_paise = 0` cannot even be inserted — `product_drafts_price_paise_check` rejects it
(SQLSTATE 23514). So a zero price is unrepresentable, not merely blocked.

*Whole suite:* `npm test` → **125 passed (125)**, 8 files, 25.87 s. `npm run typecheck`
clean, `npx eslint .` clean. `npm run verify:isolation` → three steps pass, and now also
`SHOPIFY_CLIENT_SECRET: NOT PRESENT ✓`.

*Cleanup:* `--cleanup` deleted 22 products and 23 drafts, keeping criterion 1's product.
SKU counters were deliberately **not** reset — `NK` stands at 112. Gaps are expected and
harmless; lowering a counter is the thing that produces a second `RS221`.

---

**Also fixed: the concurrency test was flaky, failing ~2 runs in 3.**

`tests/next-sku.concurrency.test.ts` treated *any* failed call as a failure, including
`fetch failed` with `status: 0` at the ~10.2 s undici connect timeout — a dropped TCP
connection, not a counter fault. A flaky test guarding this project's most important
invariant is worse than no test, because people learn to ignore it.

Now split: an **answered** error (any HTTP status) is still a hard failure; a **dropped
connection** is tolerated up to 10% and *reported by name*. The assertions that matter —
no duplicates, every number inside the prefix's own range, counter movement bounded below
by successes and above by calls issued — hold regardless. The strict "exactly consecutive,
counter exactly +100" check still runs whenever all 100 completed, so a real regression
cannot hide behind a network excuse. Verified stable over four consecutive runs, each
still reporting `peak concurrent calls 100`.

**Not finished / known broken:**

- **`SUPABASE_DB_PASSWORD` is still stale** — `npm run db:push` → `28P01`. All four Phase
  2 migrations were applied through the Supabase Management API and are recorded in
  `supabase_migrations.schema_migrations`. `db:push` has still never run successfully.
- `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env` is **still the broken multi-line paste** — the
  validator now catches it (`reason: truncated`) and `/health` shows it, but the value
  itself needs re-pasting base64 on one line.
- `NP` has no tag, so Nose Pins cannot publish. Deliberate (D23).
- The Supabase Storage bucket `images` still exists. Out of scope, destructive.

**⚠️ BLOCKING BEFORE LIVE CUTOVER — must be collected from the business:**

- [ ] **Real per-category weights in grams.** Every `default_weight_g` is currently **0**,
      which publishes 0 g and reproduces exactly the live-store bug that makes weight-based
      shipping impossible. Acceptable on `qimti`; not acceptable live. (D19)
- [ ] The exact Shopify tag for **Nose Pins**, read off a live product. (D23)
- [ ] SKU prefix, title pattern and tag for the remaining seven: Watches, Hand Chains,
      Jewellery Box, Bags, Hair Accessories, Indian Jewellery, Brass.
- [ ] Confirm the live store's **currency** — the test store is USD; prices are paise.
- [ ] Point the theme template at `product.metafields.custom.material`. (D21)
- [ ] Re-run `npm run seed:counters` against the live store. Sanity check: it should find
      NK 970 · ER 453 · BK 317 · CB 352 · RS 224 · AK 087.
- [ ] Default stock per category.

**Surprises:**

1. **`lpad` truncates.** See above. The single most valuable thing this session produced.
2. **`productSet` requires `productOptions` even when there are no options.** The error
   message is exact and helpful, which is not always true of Shopify.
3. **The test store is USD with a POUNDS default weight unit.** Neither affects Loupe —
   weight unit is sent explicitly — but the currency needs confirming at cutover.
4. **`price_paise = 0` is unrepresentable**, so criterion 6's "zero price" case could not
   be constructed as written. The assertion became stronger: the database refuses to store
   it at all.
5. **Piping a long-running script through `head` kills it.** `npm run verify:publish |
   tee f | head -60` → `head` exits, `tee` takes SIGPIPE, the run dies at criterion 4 and
   leaves debris. Redirect to a file and read the file.

**Next session should start with:** Phase 3 — but first re-paste
`GOOGLE_SERVICE_ACCOUNT_JSON` base64-encoded on one line and confirm `/health` shows the
service-account address, since Phase 3 is the Drive watcher and that credential is its
first dependency.

---

## 2026-07-28 — Phase 2 (part 1): the Shopify write path

**Goal this session:** the token manager, `seed:counters`, and `publishProduct()`.

**Superseded by the 2026-07-29 entry above** — the app was installed and criteria 1–4 were
then demonstrated. Left intact as the record of what was true at the time.

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
