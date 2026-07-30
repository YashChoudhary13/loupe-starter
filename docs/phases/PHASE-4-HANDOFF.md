# Phase 4 — handoff

Written 2026-07-30, mid-phase. **Phase 4 is not complete.** The console is built, deployed
and publishes a correct product; the acceptance harness has never been run past `seed`, and
operator testing found three requirements the build does not meet.

Read `CLAUDE.md`, `docs/CONTEXT.md`, `docs/PROGRESS.md` (top entry) and
`docs/phases/PHASE-4-listing-console.md` before touching anything. This file is the
shortest path into the current state; it is not a substitute for those.

---

## 1 · What exists and works

The console is live at **https://qimati-loupe.vercel.app** — `/login`, `/console`,
`/console/drafts/[draftId]`.

- **Sign-in.** Direct Google OAuth (D44), PKCE, HMAC-signed session cookie, authorisation by
  exact `app_users` membership re-read on every protected surface. `/health` validates the
  OAuth client pair and currently reports `accepted`.
- **The write path.** All of it is Postgres functions (migration `20260730140000`), because
  the three races the console can lose are decided there: grouping claims a photograph with
  `WHERE product_draft_id IS NULL`, saving carries the `updated_at` it was loaded with, and
  publishing takes a UUID lease. All three are proved against the deployed database in
  `tests/console-drafts.sql.test.ts`.
- **Publishing** goes through the existing `publishProduct()`. Images ride on `productSet`'s
  declarative `files`; each draft image records the Shopify media id it became, which is
  what stops a retry or a reorder duplicating media (D47). Alt text is the cached
  description of that source photograph, trimmed at 512 characters, falling back to the
  product title (D48). No model call is made anywhere in the console.
- **Drive housekeeping** runs last, separately, and cannot fail a publish (hard rule 3).

**332 tests pass.** typecheck, lint, build, `verify:isolation` and `supabase db lint` are
all clean.

### The one real end-to-end publish

Done by the operator through the UI, not by the harness:

```
gid://shopify/Product/8033052557395
Necklace 113 · necklace-113 · NK113 · tag Necklace · Jewellery · ACTIVE
custom.material 316L · price 125.00 · stock 12 · weight 0 g
1 image, alt = the 454-character cached description, verbatim
phase4-necklace.png moved to Drive /Processed
```

The event trail is complete and attributed to `lakhira.studio@gmail.com`.

---

## 2 · The three gaps — do these first

These came out of the owner using the console. Two are business decisions; one is a
straightforward change.

### 2.1 The product has no description

**This is D6 working as designed**, and the design has a missing half. Loupe deliberately
writes no `descriptionHtml` — the six bullets are supposed to render from the theme using
`product.metafields.custom.material`, which is why the live catalogue's WhatsApp CSS classes
are not being reproduced. The metafield **is** being written correctly (`316L` above).

What has never happened is the theme change. It is open question 5 in `docs/CONTEXT.md`.

Two ways forward, and this is the business's call, not the next agent's:

- **update the theme** to read `product.metafields.custom.material` and render the bullets —
  keeps D6, keeps a wording change to one edit rather than 1,600 updates; or
- **reverse D6** and have Loupe write `descriptionHtml` per product — faster to see, but
  puts body copy back on every product and makes a wording change a bulk rewrite.

Do not silently pick one. If D6 is reversed, that is a new numbered decision explaining why.

### 2.2 The price shows in USD

`shop.currencyCode` on `qimti.myshopify.com` is **USD**, so `125.00` renders as $125.00.
Loupe stores paise and writes a currency-less decimal string; Shopify applies the store's
own currency. So this is store configuration rather than a Loupe defect — but it is open
question 3 in `docs/CONTEXT.md` and it must be settled before the Phase 7 cutover.

Either set the test store to INR so what the operator sees matches what they typed, or
accept the mismatch on the test store and make INR a hard precondition of cutover. Whichever
is chosen, record it — an operator reading "$125.00" after typing 125 will eventually type
the price they think fixes it.

### 2.3 The `Newest` tag is missing

New requirement, stated 2026-07-30: **every product needs a `Newest` tag alongside its
category tag.** Not implemented — Loupe writes only `categories.shopify_tag` today.

**Confirm the exact casing against a live product first.** The entire reason `shopify_tag`
is stored per category and matched verbatim is that collections are tag-driven, so `newest`
/ `NEWEST` / `New` would publish successfully and drop the product out of its collection
with no error anywhere (D23 is the same trap).

Where to change it, in preference order:

- `src/lib/publish/publish-product.ts` builds `tags: [identity.shopifyTag, ...options.extraTags]`.
  A constant beside `PRODUCT_TYPE` is the smallest change and applies to every publish path.
- If the set of always-on tags is likely to grow, a table is better than a constant — but do
  not build that until there is a second tag.

Update `tests/` and re-run `npm run verify:publish` for the Phase 2 path, and add the tag to
the criterion 10 assertions in `scripts/verify-phase4-live.ts`.

---

## 3 · One reported bug that is not a persistence bug

"Save Draft does not add the product to draft." The database disagrees: `draft.created` and
`draft.saved` were both written at 08:33:05 and 08:33:09, before any publish, and the draft
persisted.

What is actually wrong is the **interface**. Save Draft is an icon-only button (`◷`) with a
tooltip and no confirmation of any kind, so a successful save is visually identical to a
dead button. Fix the feedback, not the persistence:

- label the button, or show a short confirmation next to it;
- the saved draft appears in the queue as a tile — make that visible, e.g. select it;
- `dirty` state is already tracked in `ConsoleScreen`; surface it as "saved" / "unsaved".

`src/components/console/DraftEditor.tsx`, the sticky action bar at the bottom.

---

## 4 · Exact current state — nothing has been cleaned up

| | |
|---|---|
| Drive `RAW IMAGES` | `phase4-chain-bracelet.jpg`, `phase4-anklet.jpg`, `phase4-ring-tray.png`, `phase4-earrings.png` |
| Drive `PROCESSED IMAGES` | `phase4-necklace.png` (moved by the real publish) |
| `intake_files` | 20 rows — 5 real fixtures, 15 `phase4-density-*` queue-density tiles |
| `image_versions` | ~35 rows; R2 objects listed in `.artifacts/phase4-acceptance/fixtures.json` |
| `product_drafts` | `NK113` (published, this session) and `NK090` (Phase 2's `verify-publish` leftover) |
| Shopify | `gid://shopify/Product/8033052557395` — **not** in `fixtures.json`, add it before cleanup |
| `sku_counters` | `NK = 113` |
| pg_cron | all four jobs **active** (they were paused during seeding and have been restored) |

`.artifacts/` is Git-ignored. `fixtures.json` drives `npm run verify:phase4 -- cleanup`.

**Before cleanup, append `gid://shopify/Product/8033052557395` to `shopifyProductIds` in
`.artifacts/phase4-acceptance/fixtures.json`** — it was published through the UI, so the
harness does not know about it.

### What is real and what is seeded

The fixtures' *enhanced* state was seeded from the retained Phase 3C output rather than
re-generated: Phase 4's brief says explicitly not to re-run that paid set, and re-generating
would prove a Phase 3B criterion. Everything the console itself touches is real — real Drive
files, real R2 objects, real presigned URLs, real Shopify products and media, real database
functions. This is stated at the top of `scripts/verify-phase4-live.ts` too.

---

## 5 · Remaining success criteria, in the order to do them

Criteria 3, 5, 6, 7, 8 and 15 are covered by the test suite. These are not:

1. **Criterion 1 — authorised sign-in.** The flow reached Google's consent screen and
   stopped there; consent has never been granted. Complete it as
   `lakhira.studio@gmail.com`, then evidence: session survives refresh, sign-out clears it,
   `events.actor` is the email.
2. **Criterion 2 — unauthorised sign-in denied.** A second Google account, **not** added to
   `app_users`. `prompt=select_account` is always sent so the chooser appears. Expect the
   access-denied screen, an `auth.denied` event, and no session cookie.
3. **Criteria 4, 9–14 — `npm run verify:phase4 -- accept`.** Guarded by
   `PHASE4_LIVE_ACCEPTANCE=I_UNDERSTAND_THIS_PUBLISHES_TO_THE_TEST_STORE`. It refuses to run
   against anything but `qimti.myshopify.com`. It uses the first five fixtures by index — one
   of them (`phase4-necklace.png`) is now published, so **make the script pick fixtures that
   are still `enhanced` and ungrouped at runtime** rather than by index. That is a small edit
   in `accept()` and it makes the harness re-runnable, which it should have been.
4. **Criterion 16 — keyboard.** select tile → category → price → Enter → publish → advance.
   The editor is a real `<form>`, so Enter submits and chips are `type="button"`; the colour
   input intercepts Enter deliberately. Verify the focus rings and that Enter never publishes
   from a chip or the colour field.
5. **Criterion 17 — visual acceptance.** Desktop and narrower laptop widths, a 20-tile queue,
   a draft with several images, a validation-error state and a successful publish. Compare
   against `design/console-mockup.html` and `docs/DESIGN.md`. Document deliberate deviations —
   there is at least one already: the sidebar shows Tracking and Prompts greyed out because
   they are Phases 6 and 5, rather than as links that go nowhere.
6. **Criterion 18 — cleanup.** `npm run verify:phase4 -- cleanup`, then confirm the four cron
   jobs are active, an empty tick returns 200, and no live-store configuration changed.

---

## 6 · Rules this phase must keep

- **Test store only.** `qimti.myshopify.com`. Phase 7 owns the live cutover.
- **D43 — model and provider selection is out of scope.** Do not change `DESCRIBE_MODEL`,
  `DESCRIBE_REASONING_EFFORT`, `IMAGE_MODEL`, `IMAGE_SIZE` or `IMAGE_QUALITY`; do not touch
  the Phase 3C prompt architecture or presentation classes; do not re-run the paid Phase 3C
  acceptance set. Phase 3C stays **not complete**.
- **Forward-only migrations.** Two are applied (`20260730140000`, `20260730141000`); do not
  edit them.
- **Do not weaken a test to make the phase green.** Two real defects came out of writing the
  Phase 4 tests — the Shopify media position-repair and the fixture cleanup order — and both
  looked like test problems first.
- `supabase/migrations/20260729081425_remote_schema.sql` is an untracked `db pull` artifact
  that starts with `drop extension if exists "pg_net"`. It is already recorded as applied
  remotely, so it is inert — but do not commit it and do not apply it.

---

## 7 · Where things are

```
src/lib/auth/            session cookie, Google OAuth, app_users authorisation
src/lib/console/         queue read model, R2 signing, mutations, money, preview,
                         publish-draft.ts + housekeeping.ts (injectable, testable),
                         publish.ts (production wiring only)
src/components/console/  ConsoleScreen, QueueGrid, DraftEditor, Sidebar, primitives
src/app/console/         page, drafts/[draftId], actions.ts (every mutation re-authorises)
scripts/verify-phase4-live.ts    seed / accept / cleanup
tests/console-*.test.ts          races, preview parity, money, housekeeping
tests/shopify-product-images.test.ts   alt text and media reuse
docs/DECISIONS.md        D43–D48 are this phase
```
