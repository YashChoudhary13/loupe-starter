# Phase 4 — handoff

Updated 2026-07-30 after owner acceptance. **Phase 4 is complete.**
All eighteen criteria pass, the two owner decisions are recorded as D49 and D50, and
Phase 5 has started.

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

## 2 · Owner decisions settled

- **D49 — currency:** Loupe writes a currency-less decimal and never converts. Shopify's
  target-store currency is authoritative. USD on the test store is accepted; confirm the
  live store currency during Phase 7 cutover.
- **D50 — description:** D6 is reversed. Loupe writes a clean standard six-point
  `descriptionHtml`, still writes `custom.material`, allows a one-off custom material,
  and permits a rare escaped plain-text description override.

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

### Criterion 2 — unauthorised refusal: PASS

The owner signed in with `yashmiuky@gmail.com`, which is absent from `app_users`, and
received the clear **No access** screen. The live audit read-back found
`auth.denied` event `5964` at `2026-07-30T11:03:24.989503+00:00` with reason
`not an active app_users row`; no application data was shown. The default-deny session
and protected-action paths remain covered by the authentication test suite.

Screenshot:
`.artifacts/phase4-acceptance/screenshots/unauthorised-denied.png`.

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
- Phase 4 is complete. New redo/prompt work follows
  `docs/phases/PHASE-5-redo-version-history-prompts.md`.

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

**Next action:** continue Phase 5 with append-only prompt creation and atomic promotion.
