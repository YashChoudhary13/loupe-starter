# Phase 4 — handoff

Updated 2026-07-30 after live acceptance and cleanup. **Phase 4 is not complete.**
Criteria 1 and 3–18 pass. Criterion 2 still needs a real Google account that is absent
from `app_users`, and two owner decisions remain unanswered.

Read `CLAUDE.md`, `docs/CONTEXT.md`, the top of `docs/PROGRESS.md`,
`docs/phases/PHASE-4-listing-console.md` and D43–D48 in `docs/DECISIONS.md` before
changing anything. This is only the shortest path into the current state.

---

## 1 · What is finished

The console is deployed at **https://qimati-loupe.vercel.app**.

- The exact live catalogue tag is **`NEWEST`**, all caps. It was read from Necklace 970,
  Earrings 453, Chain Bracelet 353 and Anklets 087 before implementation.
  `publish-product.ts` now adds it beside every category tag for every publish path.
- Save Draft visibly moves through `Saving…` to `Saved`.
- A successful publish remains visible after the editor advances.
- Keyboard focus advances by stable intake ID rather than an obsolete queue index.
- Generated-image filenames use the selected R2 object extension, so a PNG generated from
  a JPEG source is accepted by Shopify.
- The live harness selects only fixtures that are still `enhanced` and ungrouped at
  runtime. Cleanup is resumable and refuses to hide database deletion errors.

Final gates:

```text
tests                    334 passed, 26 files
typecheck / lint / build passed
verify:isolation         all server secrets absent from client assets
supabase db push dry-run remote database up to date
supabase db lint         no schema errors
deployment               dpl_3x9aKdzfW3J8XVqqoMSc8syXQEB3 · READY
```

No Phase 3C model, provider, prompt, presentation, image-size or quality value changed,
and the paid Phase 3C set was not rerun. Phase 3C remains **not complete** under D43.

---

## 2 · Business decisions still required

These questions were put to the owner this session but were not answered. Do not choose
either one silently.

### 2.1 Description: keep D6 or reverse it

Loupe deliberately writes no `descriptionHtml`. It writes
`product.metafields.custom.material`, and D6 expects the six bullets to render from that
metafield in the theme. The theme has never been changed, so the product has no visible
description.

The owner must choose:

1. **Keep D6 and change the theme** to render the material-specific bullets. This keeps
   wording centralised and avoids rewriting roughly 1,600 products when copy changes.
2. **Reverse D6 and write `descriptionHtml` per product.** This makes the body self-contained
   but returns wording to every product record.

If D6 is reversed, add a new numbered decision to `docs/DECISIONS.md` with the reasoning.

### 2.2 Currency: test-store USD or intended production currency

`qimti.myshopify.com` has `shop.currencyCode = USD`. Loupe writes a currency-less decimal,
so Shopify correctly renders `$125.00` for the operator’s `125`. This is store
configuration, not a Loupe price conversion defect.

The owner must choose:

1. change the test store to the intended production currency now; or
2. accept the test mismatch and make INR a hard Phase 7 cutover precondition.

Also confirm the live store’s actual currency before cutover. Record the choice in
`docs/CONTEXT.md` and, if it establishes a durable architectural/operating rule, in
`docs/DECISIONS.md`.

---

## 3 · Success-criterion evidence

### Criterion 1 — authorised sign-in: PASS

`lakhira.studio@gmail.com` completed the real Google account chooser, reached `/console`,
survived refresh, signed out to `/login`, then signed in again. `auth.signed_in` and
`auth.signed_out` events were read back with that exact actor before cleanup.

Cleanup then exposed a harness bug: because the live acceptance actor was also the owner
email, a broad delete-by-actor removed those authentication rows together with fixture
events. They were not fabricated back. The cleanup code now deletes only exact fixture
entity IDs. The pre-cleanup read-back remains the criterion evidence, but the live audit
table no longer holds those two historical rows.
The incident is recorded honestly as event `5212`, `phase4.cleanup.audit_loss`; its detail
states that the deleted history was not recreated.

### Criterion 2 — unauthorised refusal: NOT PROVEN

Only the authorised owner account was available in the browser. Use any second valid
Google account and **do not add it to `app_users`**.

Required evidence:

- the Google callback reaches the clear Access denied screen;
- an `auth.denied` event records the refused email;
- no `loupe_session` cookie is issued;
- `/console` still exposes no data;
- a protected server action is refused.

This is the only unproven Phase 4 success criterion.

### Criteria 3, 5, 6, 7, 8 and 15: PASS

Covered by the 334-test suite and `verify:isolation`, including deployed grouping/save
races, version/order persistence, paise conversion, sticky defaults, preview/database
parity for every configured category, browser resume and the default-deny boundary.

### Criteria 4 and 9–14: PASS

The guarded test-store harness completed with `failures: 0`.
Retained evidence: `.artifacts/phase4-acceptance/acceptance.json`.

```text
criterion 4   private signed thumbnail 200; expired 403; unsigned 400; 20 thumbnails
criterion 9   images/material/price/stock blocked together; no SKU reservation
criterion 10  gid://shopify/Product/8033090109523 · NK138 · 3 images
              Necklace + NEWEST + loupe-phase4-acceptance
criterion 11  retry reused NK138, handle, product ID and media IDs
criterion 12  gid://shopify/Product/8033091190867 · NK139
              two concurrent submits, one product, one image
criterion 13  each alt matched its own cached source; no describe event
criterion 14  Drive moves happened after publication; repeat safe; forced 403 did not undo
```

All acceptance Shopify products were deleted during cleanup; the IDs remain evidence.

### Criterion 16 — keyboard: PASS

Proved in a real Chromium session:

- Tab reached the roving queue;
- arrows moved between tiles and Space selected one;
- selection focused price;
- Shift+Tab reached category; Enter/Space selected category and material;
- Enter in Add colour added `Rose Gold` without publishing;
- Escape cleared an in-progress selection;
- Enter in price published;
- visible focus treatment was a 2px black ring/inset shadow;
- NK142 advanced focus to the next ungrouped photo,
  `phase4-density-06.png`.

### Criterion 17 — visual acceptance: PASS

Compared to `docs/DESIGN.md` and `design/console-mockup.html`. Desktop and 1180×768
laptop layouts have no horizontal overflow and retain dense thumbnails, photograph-only
colour, pill controls, 24px cards, 16px tiles, black feature card and sticky actions.

Screenshots:

```text
.artifacts/phase4-acceptance/screenshots/desktop-20-tile-queue.png
.artifacts/phase4-acceptance/screenshots/desktop-multi-image-draft.png
.artifacts/phase4-acceptance/screenshots/laptop-multi-image-draft.png
.artifacts/phase4-acceptance/screenshots/validation-error.png
.artifacts/phase4-acceptance/screenshots/keyboard-publish-success.png
```

Deliberate deviation: Tracking and Prompts are grey labels for Phases 6 and 5 rather than
links that go nowhere.

### Criterion 18 — cleanup: PASS

Retained receipt: `.artifacts/phase4-acceptance/cleanup.json`.

```text
Shopify       6 recorded Phase 4 products absent, including NK113 and NK138–NK142
Drive         5 exact fixture IDs in Trash
database      26 intake rows and 8 drafts deleted; 0 remain
R2            15 recorded keys deleted; 0 remain
pg_cron       4/4 Loupe jobs active; latest runs succeeded
empty ticks   watch/reconcile/sweep/enhance all HTTP 200
enhance tick  claimed=0 · enhanced=0 · descriptionCalls=0
```

The Drive service account can move those owner-created files but cannot trash them.
Cleanup therefore used the owner’s authenticated Drive UI for the exact recorded five
IDs, then the resumable harness verified their trashed state. No live-store write or
configuration change occurred. A separate broad actor-event deletion was also removed
after it was found to have erased the owner’s pre-cleanup authentication audit rows.

---

## 4 · Current production/test state

- The deployment points only to `qimti.myshopify.com`.
- All Phase 4 acceptance products and fixtures are gone.
- The NK counter is at 142. Gaps from acceptance and cleaned products are intentional;
  counters never move backwards after a real reservation.
- The older Phase 2 NK090 draft was outside the Phase 4 fixture set and was not touched.
- All four pg_cron schedules are active.
- `.artifacts/` is Git-ignored and preserves acceptance JSON, cleanup receipt, screenshots
  and browser trace/snapshots.

---

## 5 · Rules that do not move

- Test store only. Phase 7 owns live cutover.
- D43: do not change `DESCRIBE_MODEL`, `DESCRIBE_REASONING_EFFORT`, `IMAGE_MODEL`,
  `IMAGE_SIZE`, `IMAGE_QUALITY`, Phase 3C prompts or presentation classes.
- Do not rerun the paid Phase 3C acceptance set.
- Forward-only migrations. `20260730140000` and `20260730141000` are applied.
- Never weaken a test to make a phase green.
- Do not mark Phase 4 complete until criterion 2 is demonstrated and the two owner
  decisions above are recorded.

---

## 6 · Where the work is

```text
src/lib/auth/                    session, OAuth and app_users authorisation
src/lib/console/                 queue, draft mutation, preview and housekeeping
src/lib/publish/                 shared Shopify publish path and NEWEST invariant
src/components/console/          queue, editor, keyboard and feedback
src/app/console/                 protected pages and server actions
scripts/verify-phase4-live.ts    guarded seed / accept / resumable cleanup
tests/console-*.test.ts          database races, preview, money and housekeeping
tests/shopify-product-images.test.ts
docs/PROGRESS.md                 complete evidence and surprises
docs/DECISIONS.md                D43–D48; add a new decision only if D6 is reversed
```

**Next action:** obtain the two owner decisions and a second Google account for criterion 2.
