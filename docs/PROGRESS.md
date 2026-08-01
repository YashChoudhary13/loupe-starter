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

## 2026-08-01 — R2 retention (D62), redo prompt review (D63), on-hold work (D64)

**Goal this session:** three owner requests — purge R2 seven days after a product reaches
Shopify, review/edit the prompt before paying for a redo, and turn terminal "skipped" into
resumable/discardable work.

**Built:**

- **D62 retention.** Daily `loupe-retention` cron at 03:30 IST purges a photograph's
  original, versions and thumbnails 7 days after its product reached Shopify by either route
  (published or the D60 draft stage). `shopify_first_sent_at` is stamped by a trigger on the
  null→non-null transition of `shopify_product_id`, so it catches every route and cannot
  drift from the two functions that set it. `image_versions` ROWS are kept forever — they
  hold the model and exact prompt behind every image (D5) — with a new `purged_at` marking
  that the bytes are gone.
- **D63 redo prompt review.** "Redo image" now opens the exact resolved prompt, editable for
  that product only, before the ~$0.07 call. An unresolved `{{TOKEN}}` is refused rather than
  sent as literal text. Resolution is shared with the queue path so preview and reality
  cannot diverge.
- **D64 on hold.** Skipped work is reclassified as **On hold** in the in-progress group with
  **Resume** (fresh retry budget — a hold is a decision, not a failure) and **Discard**
  (Drive file out of RAW → R2 objects → row, in that order, each step idempotent).

**Verified:** `441 passed` across 41 files (+3 on-hold SQL regressions), typecheck, lint,
build clean. Six cron jobs active including `loupe-retention` at `0 22 * * *`. Deployed and
aliased; `/health` 200 and `POST /api/cron/retention` unauthenticated returns **401** — the
endpoint that deletes files refuses anonymous callers.

Retention proved against the live database rather than assumed empty:

```text
retention_candidates(7)  → 0   (products reached Shopify yesterday, not 7 days ago)
retention_candidates(0)  → 7   (the same query finds all 7 versions)
```

The zero is the age gate doing its job, not a query that matches nothing.

**Owner setup completed mid-session:** `DRIVE_DISCARDED_FOLDER_ID` was created and set. It
was local-only, so production would have silently fallen back to `/Processed`; it is now set
on Vercel production and documented in `.env.local.example`.

**Not finished / known broken:**

- **None of the three has been exercised end-to-end by a human.** Retention has no rows old
  enough to purge yet (first real purge ~2026-08-07). Redo review and Resume/Discard are
  proven at SQL and unit level only — no real redo has been run through the dialog and no
  real file has been discarded out of RAW.
- `enqueue_image_redo()` predates `prompt_override`, so the override marker is recorded by a
  follow-up UPDATE rather than inside the RPC transaction. What the model receives is correct
  either way; only the "a human edited this" flag could be lost, and that is logged.

**Surprises:** the on-hold tests initially failed with "current transaction is aborted" —
that suite shares one connection inside a rolled-back transaction, so a deliberately-raised
error poisons everything after it. Expected failures now run inside savepoints.

**Next session should start with:** run a real redo through the review dialog, and discard a
real held photograph, confirming the file actually leaves RAW and lands in /Discarded.

---

## 2026-07-31 — Shopify draft stage (D60), navigation caching (D61), Enhanced label, cost in Tracking

**Goal this session:** four owner requests — caching so section switching feels smooth, Save
Draft writing to Shopify, "Enhanced" instead of a vague in-progress label, and per-item cost
in Tracking.

**Built:**

- **D60 — Save Draft now creates a real Shopify product with status DRAFT.** This reverses
  D7's "no Shopify draft stage", so it was put to the owner as an explicit decision with its
  cost attached rather than just implemented: a Shopify product needs a SKU and handle, so
  drafting allocates the SKU early and an abandoned draft burns that number for good. The
  owner accepted. `reserve_draft_identity` gains `p_require_publishable` (default `true`)
  which relaxes **only** the price guard; category, confirmed tag (D23) and the D27 category
  pin still apply to a draft, and publish is untouched. New
  `record_draft_shopify_product()` records the id without publishing intake rows or counting
  colour usage. Migration `20260731130000_shopify_draft_stage.sql`.
- **D61 — two narrow caches.** `staleTimes.dynamic = 30` lets the client router reuse a
  section for 30s; `currentOperator()` wrapped in React `cache()` collapses repeated auth
  lookups within one request. Neither is a security boundary — auth is still re-read every
  request and inside every server action (D44).
- **Tracking:** an enhanced photograph now reads **Enhanced** rather than "Waiting" (the old
  label described what the operator still had to do and read as though the pipeline had not
  finished), and each row shows what that photograph actually cost — description plus every
  generated image, redos included, from provider-reported figures only.

**Verified:** `438 passed` across 41 files (+4 new D60 regressions), typecheck, lint, build,
`verify:isolation` all clean. Deployed and aliased.

Deployed-SQL evidence for D60, run against the live database inside a rolled-back
transaction:

```text
publish path      BLOCKED: reserve_draft_identity: draft … has no price
draft path        reserved NK191 with no price
status after      assembling   (not 'publishing', not 'published')
shopify id        recorded
NK counter        190 -> 191 during the test, back to 190 after rollback
```

**Two defects this session's own checks caught, not inspection:**

1. The first cut of `record_draft_shopify_product` left the draft in `publishing` — the
   status `reserve_draft_identity` sets. It would have been uneditable in the console and
   reported stalled by Tracking within the hour. Found by reading the actual status back
   rather than trusting the function returned without error.
2. While adding the draft branch I wrote `resolveWeightG(input) ?? 0`, which silently
   defeats D19 on the **publish** path — NULL weight means "nobody has said" and must block,
   never become 0. Caught on re-reading the diff; the coercion now applies to drafts only
   and publish keeps its assertion.

**Not finished / known broken:**

- **D60 has not been exercised against the real test store.** Every check above is SQL-level
  and unit-level; no Shopify draft product has actually been created by a real Save Draft
  click. That is the next thing to prove.
- The migration was corrected in place (ledger row dropped, `db:push` re-run) rather than
  by a follow-up migration, because it was applied minutes earlier in this same uncommitted
  session. Anything already committed must still be corrected forward-only.
- Tracking shows cost per photograph only; drafts and reconciliation rows show nothing,
  which is correct — cost is billed per source photograph, and null there means "not a
  billed item", never zero.

**Surprises:** the owner's four small requests split cleanly into two that were genuine
one-liners and two that touched the most dangerous code in the system. Reversing D7 needed
the SKU-burn consequence surfaced *before* implementing, not after.

**Next session should start with:** click Save Draft on a real product and confirm a DRAFT
product appears in the test store with the right SKU/handle, that Publish then flips that
same product to ACTIVE without creating a second one, and that the burned-number behaviour
is what the owner expected in practice.

---

## 2026-07-31 — D56 proved live; console lag fixed (self-inflicted); arrival bubble

**Goal this session:** owner reported five things — progress pill stuck on an already-enhanced
photo, Drive files not moving to /Processed, a re-upload that "didn't process", a request for
an arrival bubble, and a UI that needed 2–3 clicks to switch sections.

**D56 is now proven live, not just by probe.** Intake `35a9161d` (the .webp) shows
attempts 1 and 2 failing `description_invalid_json` with fenced JSON, then attempt 3 at
09:19:06 — after the prompt promotion — succeeding: `description.stored`,
`google/gemini-3.1-pro-preview`, 87 words, `pair-upright`, `$0.004584`, then
`intake.enhanced` at `$0.0686625` (under the $0.20 ceiling). The fence fix works end to end
on a real Drive photograph with a non-OpenAI model.

**Diagnosis of the five reports:**

1. **Stuck progress pill — real bug, mine.** `pipelineActivity.uploading` counted every
   `discovered` row. A row in retry backoff is *also* `discovered` (D29), so a photograph
   waiting up to an hour between bounded retries was reported as "uploading" the whole time.
   Now counts `attempts = 0` only; backoff belongs to Tracking, which alerts on age and
   failure (hard rule 5).
2. **The UI lag — also mine, same change.** The 5-second poll called the FULL
   `refreshQueueAction()`, which re-signs every thumbnail; a presigned URL differs on every
   call, so every `img src` on the page changed every five seconds and the browser
   re-downloaded the entire grid — continuously, because bug 1 held it in fast-poll mode.
   That is the "stuck, laggy, needs 2–3 clicks". Split into a cheap `pipelineActivityAction()`
   (two COUNTs, no rows, no signing) polled every 5s, with a full refresh only when the
   in-flight count *falls* (work finished) or on the existing 9-minute URL timer.
   `preserveThumbs()` additionally carries still-valid URLs across a refresh so the images
   never churn; it lives in `queue-view.ts` with four tests, including one asserting that
   only the URL is inherited and never a stale count, tile or attention flag.
3. **/Processed — working as designed, not a regression.** Drive housekeeping runs on
   PUBLISH, not on enhance (D37, hard rule 3). `77f54637` was published at 07:36 and moved;
   the others were never published, so they correctly stayed in RAW.
4. **The "re-upload that didn't process" — it did.** It was discovered at 08:07 as a new
   Drive id, failed describe three times on the fence bug, and was then **skipped by the
   owner** — `intake.skipped`, actor `lakhira.studio@gmail.com`, 08:35. `skipped` is a
   terminal operator decision, so the worker correctly ignores it, and it stays in RAW
   because it was never published.
5. **Arrival bubble — built.** A monochrome toast at the top of the console when the
   uploading count rises, auto-dismissing after 6s. Deliberately not amber: amber means "a
   human is needed" and nothing else (D9); a photograph arriving is normal.

**Verified:** `434 passed` (41 files, +4 for `preserveThumbs`), typecheck, lint, build all
clean. Deployed `dpl_DzNQue4ysd8xiKvmToadFk5GVSit`, Ready, `/health` 200.

**Not finished / known broken:**
- The new console behaviour is deployed but not yet exercised by the owner against a real
  Drive upload. **A hard refresh is required** — client JS does not hot-swap across a
  deploy, so an old tab keeps the old polling code (this likely explains part of report 5).
- Intake `3fbc19e1` remains `skipped` and its file remains in RAW. Reconcile re-scans it
  harmlessly every 15 minutes (`inserted: 0`). If the owner wants that photograph after all,
  it needs a fresh upload — skip is terminal by design.
- Files that end `skipped`/`failed` accumulate in RAW forever, since only publish moves a
  file. Not a bug today at this volume; worth a decision before the live cutover.
- Drive push notifications (webhooks) still not built — see the entry below.

**Surprises:** both genuine bugs this session were introduced by the previous session's
progress-pill feature, not by anything older. A 5-second poll of an endpoint that mints new
presigned URLs is indistinguishable from a cache-busting attack on your own UI.

**Next session should start with:** owner hard-refreshes `/console`, drops a real photo in
Drive, and confirms the bubble, the honest counter, a responsive UI, and the photo landing
in the grid on its own.

### Follow-up the same session — why switching sections was slow (D58, D59)

The owner then asked why clicking a section takes time to open. Two causes, both measured:

- **Functions ran on the wrong continent.** No `vercel.json` existed, so functions defaulted
  to `iad1` (Washington DC) while Supabase is `ap-south-1` and R2 is APAC. Proven from the
  response header, not assumed: `x-vercel-id: bom1::iad1::…` — Mumbai edge, Washington DC
  function. Pinned to `bom1`. `/health` went from `0.738s / 1.101s / 1.289s` to a median of
  `0.369s` over six warm runs (~3×), and the console does far more database work than
  `/health` does. Header now reads `bom1::bom1`.
- **No loading boundary.** All three protected routes are `force-dynamic`, and without a
  `loading.tsx` Next.js keeps the old page on screen for the whole round trip — the click
  appears to do nothing. Added `ScreenSkeleton` + a `loading.tsx` per route.

Deployed `qimati-loupe-iroyu338i`, Ready and aliased. Note the first hit after any deploy is
a cold start (measured 4.18s once, then 0.33–0.68s warm) — that is the function booting, not
the region choice.

The owner then asked whether the remaining skeleton flash is a free-Vercel limit. Answered
honestly: **no**. It is the dynamic round trip these screens require by design (D11 auth
re-check, D4 presigned URLs); the free tier only contributes the occasional cold start. Left
as-is by agreement — the dependent query waves in `loadQueue()` and a per-request memo on
the `app_users` lookup are the real remaining optimisations, and neither was done.

### Full-size image review in the console

Owner asked to be able to click the product image in the editor and maximise it. Built
`ImageLightbox`: the hero image and each photograph's filename open a full-screen review,
with arrow keys / on-screen arrows stepping through the product's images **in publish
order**, showing only each photograph's SELECTED version (comparing versions stays with the
orig/v1/v2 chips). This is a real operating need, not decoration — the operator is the last
person who can catch a generated image that invented a chain link or a stone, and Qimati's
retailer buyers zoom in to judge build quality (docs/CONTEXT.md).

Two hazards handled deliberately:

- Every new control is `type="button"`. The editor's hero sits inside the publish `<form>`,
  so an implicit `type="submit"` on the image would have **published the product on click**.
- The lightbox's Escape listener runs in the capture phase and calls
  `stopImmediatePropagation()`. The console already listens for Escape on `window` to
  abandon a photograph selection, so without this, closing the image would also have
  silently discarded the operator's selection. Focus is restored to the trigger on close, so
  the keyboard path (Phase 4 criterion 16) survives.

`434 passed`, typecheck, lint, build clean. Deployed and aliased. Not yet exercised by the
owner against a real multi-image product.

---

## 2026-07-31 — Real fix for the Gemini describe failure; GIF/TIFF intake; webhook question open

**Goal this session:** owner reported a new Drive upload "did not take" and "did not start
any queue" after the D55 deploy, and asked for real testing, broader format support, and to
consider Drive push notifications. Investigation found D55 shipped on documentation
reasoning alone, unverified against a real call — and the file HAD queued; the describe
call was still failing the same way.

**Built:**
- **D56** — two real OpenRouter calls to `google/gemini-3.1-pro-preview` (a few cents,
  `.artifacts` not needed, logged in DECISIONS.md) proved the failure was the markdown fence,
  not reasoning-token truncation as D55 assumed (`reasoning_tokens: 0` in both real calls).
  Fixed the live describe prompt itself, through the proper Phase 5 mechanism
  (`create_prompt_version` + `promote_prompt_version`, actor
  `script:describe-prompt-fence-fix`) — added an explicit "no markdown, raw JSON only"
  instruction. `max_completion_tokens` raised 512 → 1500 as an evidence-scoped margin, not
  because either real call needed more than 122 tokens.
- **D57** — `supabase/migrations/20260731120000_widen_intake_image_formats.sql` widens
  intake from JPEG/PNG/WebP to also accept GIF and TIFF, checked directly against the
  deployed sharp/libvips build's actual codec support rather than assumed. HEIC/HEIF
  (iPhone default) deliberately NOT added — the same runtime check shows libheif present
  without the licensed HEVC decoder real `.heic` files need; accepting the MIME type would
  have traded a clear intake rejection for a confusing worker-stage failure.
- Self-caught regression: the first cut of the D57 migration was based on the *original*
  Phase 3A `discover_intake_file`, silently reverting a same-week decimal-MB fix
  (`20260729124000_intake_size_limit_decimal_mb.sql`, 50 MiB back to 50,000,000 bytes) that
  a later migration had already corrected. Caught by the existing test suite
  (`intake-queue.sql.test.ts`), not by inspection. Fixed live within minutes via
  `apply_migration`, ledger re-synced by dropping and re-running the corrected file through
  `db:push` so the recorded migration matches what's actually deployed.

**Verified:** `430 passed` (41 files — the count is unchanged net; one test rewritten to
assert the durable invariant instead of a pinned prompt hash, one message-text assertion
updated for the widened format list), typecheck, lint, build all clean. Live-verified
directly against the database: GIF and TIFF now queue (`status: discovered`); a
50,000,001-byte file is still rejected and exactly 50,000,000 bytes still passes; the
malformed-JSON regression from the migration mistake is gone. **Not yet deployed to
Vercel** — code changes are local; the prompt and migration fixes are already live in the
database (Supabase changes apply immediately, independent of the Vercel deploy).

**Not finished / known broken:**
- The describe-prompt fix is evidence-based (two real calls) but not yet proven against a
  real Drive upload end-to-end post-deploy — ask below.
- Real-time progress: investigation found polling already detects a new Drive file within
  ~60s as designed — that was not actually the "did not take" cause. The likelier
  explanations: (a) the console tab was open from before the earlier deploy, so the faster
  polling code hadn't loaded yet (a page reload is required — client JS does not hot-swap
  across a Vercel deploy); (b) the file WAS discovered and queued but then sat invisible
  through repeated describe-retry backoff (up to ~90 minutes across 5 attempts) because of
  the same fence bug — now fixed. No code change made here; flagging rather than guessing
  further.
- Google Drive push notifications (webhooks) were asked about but not built. Evidence above
  shows polling was not the actual bottleneck this time, and webhooks are a real subsystem
  (public receiver endpoint, channel verification token, 7-day channel expiry + renewal
  cron) — deferred pending an explicit answer to the question posed to the owner rather than
  building it speculatively.

**Surprises:** the empirical test directly contradicted D55's own reasoning — real
`reasoning_tokens` were 0, not the dominant spend the documentation-only theory predicted.
Documentation explains what a provider *can* do; it doesn't substitute for one real call
when a fix is about to ship a second guess on the same failure.

**Next session should start with:** deploy to Vercel, then get the owner to drop a real
photo in Drive and confirm end-to-end: discovered → described (clean JSON, any curated
model) → enhanced → visible in console without a manual refresh.

---

## 2026-07-31 — Describe model choice now works for any curated provider (D55)

**Goal this session:** owner switched the describe model to `google/gemini-3.1-pro-preview`
in `/prompts`; its first live call failed `description_invalid_json` on a real photo
(`IMG20260731130153.jpg`, intake `9…` — see Tracking). Owner's instruction: any model chosen
from Prompts should work; only the $0.20/image ceiling is non-negotiable.

**Built:**
- `src/lib/enhance/openrouter.ts` → `supportsReasoningControl()` widened from `openai/`-only
  to the four provider families OpenRouter documents as supporting the unified `reasoning`
  parameter (`openai/`, `google/`, `anthropic/`, `qwen/`) — every family in the ten curated
  describe models. `max_completion_tokens` 256 → 512 as margin for suppressed-but-still-billed
  reasoning tokens. D55 records why, and explicitly why `parseStructuredDescription()` was
  NOT loosened (D41's fenced/prose-JSON rejection is deliberate and tested).
- `tests/openrouter-enhancement.test.ts` → replaced the single "OpenAI-only" test with one
  proving reasoning controls now reach `google/`, `anthropic/` and `qwen/` describe models,
  plus a kept negative case (an uncurated provider family still gets nothing).
- `tests/prompt-model-selection.sql.test.ts` → was pinned to the literal
  `openai/gpt-5.6-sol`/`openai/gpt-image-2`, which broke the moment the owner legitimately
  picked a different curated model. Rewritten to assert the durable invariant instead: exactly
  one current model per stage, and it is curated — not which one.

**Verified:** `430 passed` (41 files, +3 net from splitting the reasoning-control test),
typecheck, lint, production build all clean. Deployed
`dpl_HAawhLFviBqRLPjVHdiaapgsdogX`, Ready at `https://qimati-loupe.vercel.app`
(`/health` returns 200 post-deploy). Not yet re-exercised against a real Gemini describe
call — no live OpenRouter call was made from this session.

**Not finished / known broken:** unverified against a real describe call on the actual
Gemini model. The stuck intake row from the original failure is still mid-retry-backoff in
production on the OLD code; it will only benefit from this fix after redeploy, either on its
next automatic retry or a fresh upload.

**Surprises:** the "OpenAI-only" restriction wasn't a recorded decision at all — just
leftover from when `gpt-5.6-sol` was the only describe model in existence, never revisited
when D51 added nine more. The test that encoded it was named after the CURRENT behavior
("omits OpenAI-only...") rather than a stated requirement, which is exactly the kind of test
that silently goes stale when the feature it predates changes.

**Next session should start with:** after deploy, confirm a Gemini (or other non-OpenAI)
describe call actually returns clean JSON against a real photo — this session's fix is
code-reasoned from OpenRouter's docs, not yet proven against a live response.

---

## 2026-07-31 — Console: live upload/processing progress, no manual refresh needed

**Goal this session:** operator feedback — after dropping files in Drive, the console showed
nothing until a manual refresh, with no sense of what was happening in between.

**Built:**
- `loadQueue()` (`src/lib/console/queue.ts`) → two added counts, `intake_files` status
  `discovered` and `enhancing`, returned as `QueueSnapshot.pipelineActivity`.
- `ConsoleScreen` → the existing 9-minute signed-URL refresh timer now runs every 5s
  instead whenever `pipelineActivity` is non-zero, and a plain-tone status pill (no amber —
  this is normal activity, not attention per D9) shows "N photos uploaded · N processing"
  above the grid. The same poll that refreshes URLs is what moves a freshly enhanced photo
  into the grid, so no second timer was added.

**Verified:** `427 passed` (41 files), typecheck, lint, production build all clean. Deployed
same session as the D55 fix below, `dpl_HAawhLFviBqRLPjVHdiaapgsdogX`, Ready at
`https://qimati-loupe.vercel.app`. Not yet exercised against a real Drive upload — no
`.env` access to trigger one from this session; see the ask to the owner below.

**Not finished / known broken:** unverified against a live upload. The 5s poll is a fixed
interval, not a push — worst case is a 5s-old count, which was judged acceptable against
adding Realtime (would need a new RLS policy per D11, a bigger structural change for a
progress pill).

**Surprises:** none — `refreshQueueAction` and its timer already existed for signed-URL
expiry; this reused it rather than adding parallel polling infrastructure.

**Next session should start with:** get the owner's real-upload confirmation (below) before
calling this done.

---

## 2026-07-31 — Session: independent verification audit, no code changes

**Goal this session:** answer "has the project finished, and does it work as intended" by
independently re-checking claims against the live system rather than trusting the log.

**Built:** nothing — read-only verification session.

**Verified:**
- Re-ran the full gate independently: `427 passed` (41 files), typecheck, lint, production
  build and `verify:isolation` all clean — same result as the Phase 6 entry below, confirmed
  fresh rather than assumed to still hold.
- Live production `/health` (`https://qimati-loupe.vercel.app/health`) reachable, 18 tables
  readable, both Google credentials accepted.
- All 5 cron jobs active with correct schedules, including `loupe-shopify-reconcile` at
  `30 21 * * *` (03:00 IST, per D54).
- Live database matches the documented state: exactly 7 categories exist — the 7 TBD
  categories from `docs/CONTEXT.md` open question 2 are genuinely absent from the schema,
  not just undocumented. `Nose Pins.shopify_tag` is still NULL, so that category remains
  publish-blocked exactly as CLAUDE.md and D23 describe.
- Found the system already processing real work unattended, post-launch: intake file
  `IMG20260731130153.jpg` (a real phone-camera filename, not a fixture) was discovered,
  hashed, described, enhanced and generated end-to-end at 07:33–07:34 UTC today — about an
  hour after the Phase 6 commit — for `$0.073624`, and sits `enhanced`/ungrouped waiting for
  an operator. The real owner (`lakhira.studio@gmail.com`) signed in at 07:29 UTC today.

**Not finished / known broken:** unchanged from the Phase 6 entry below; restated here so
it's visible without reading the whole file:
- Phase 3C: description cost is ~$0.015–0.017/product against a required `< $0.006` target,
  deliberately deferred per D43/D42, not fixed.
- Phase 7 (live-store cutover) has not started — no phase prompt file exists for it yet.
  Loupe still points only at `qimti.myshopify.com`.
- Nose Pins publish is still blocked (`shopify_tag` NULL); seven categories (Watches, Hand
  Chains, Jewellery Box, Bags, Hair Accessories, Indian Jewellery, Brass) still have no SKU
  prefix, title pattern or tag defined at all.
- One real ungrouped photograph (`IMG20260731130153.jpg`, intake id
  `77f54637-ee23-4880-bca9-b62664ca6558`) now sits in the queue waiting for an operator to
  group and publish it.

**Surprises:** the owner had already started using the deployed console for real before this
session, unprompted — not something logged by a prior session.

**Next session should start with:** if continuing product work, group and publish
`IMG20260731130153.jpg` from the real queue, or start scoping Phase 7 (parallel live-store
run and cutover) per `docs/CONTEXT.md` open questions 1, 3, 4, 6 and 7.

---

## 2026-07-31 — Phase 6 complete: tracking, duplicate detection and Shopify reconciliation

**Goal this session:** finish Phase 6, prove every operating path against the deployed test
environment, deploy it and remove all acceptance data.

**Built:**

- `/tracking` → protected attention, progress and all-work views with truthful photo/product
  counts, age/status/error/search filters, plain reasons, detail history and audited actions.
- Enhancement and Console → deterministic 64-bit perceptual hashes, near-copy warnings and
  durable operator review decisions that never block publishing.
- Shopify reconciliation → one leased, read-only run with durable field-level issues, a
  signed-in manual action and an authenticated daily `03:00 Asia/Kolkata` cron.
- Migration `20260731100000_phase_6_tracking.sql` → Phase 6 tables, enums and service-role
  RPCs; D53 and D54 record the duplicate and reconciliation contracts.

**Verified:**

- `427 passed` across 41 files; typecheck, lint, production build, `verify:isolation`, and
  linked Supabase database lint passed.
- Live duplicate fixtures produced pHash distance `2`; the newer image was warned in
  Tracking and Console while Publish remained available. Browser dismissal stored
  `dismissed` for the canonical pair with actor `lakhira.studio@gmail.com`.
- Live product `NK190` / `gid://shopify/Product/8033774403667` first reconciled clean,
  produced one durable issue after a deliberate expected-title mismatch, and returned
  clean after restoration. Signed-in manual run
  `d8d59a64-4b88-4a6c-93b5-82f8eb1659a4` completed `1/1` with zero issues.
- Production browser review proved the attention badge, photo/product labels, failed,
  stalled and duplicate rows, filters, keyboard search/clear, details, manual Shopify check,
  duplicate warning and the working Ungrouped/Listed console views. Evidence:
  `.artifacts/phase6-acceptance/tracking.png`, `tracking-details.png` and
  `console-duplicate-warning.png`.
- Five cron jobs are active; `loupe-shopify-reconcile` runs at `30 21 * * *`.
  Deployment `dpl_FXFDSY958S7MAaPjXhg8ik4mqqLr` is Ready at
  `https://qimati-loupe.vercel.app`.
- Cleanup removed all four intake fixtures, the draft, reconciliation runs, six R2 objects
  and the Shopify product. Read-back returned `0` intakes, `0` drafts, `0` acceptance runs
  and a null Shopify node.

**Not finished / known broken:**

- Phase 6 has no remaining criteria. Phase 3C remains separately incomplete on its
  descriptor cost gate.
- Phase 7 live-store parallel run and cutover has not started. Loupe still points only at
  `qimti.myshopify.com`.

**Surprises:** browser acceptance exposed inconsistent sidebar attention badges outside
Tracking; Console and Prompts now load the same real count. Cleanup exposed two foreign-key
ordering assumptions and is now idempotent and dependency-safe.

**Next session should start with:** define the Phase 7 parallel-run and cutover plan, then
settle the remaining live-store category/tag, stock and currency checks before changing any
Shopify credentials.

---

## 2026-07-30 — Phase 5 complete: prompt management and durable image redo

**Goal this session:** finish every remaining Phase 5 criterion, prove the real paid path
in the test environment, deploy it, and clean all acceptance fixtures.

**Built:**

- `/prompts` → authorised operators can create immutable non-current prompt versions and
  deliberately promote one; image templates are validated and every action is audited.
- Console editor → `Redo image` appends a new unselected version while original and all
  earlier generated versions remain available for review.
- `image_redo_jobs` and worker → redo reuses the cached description and presentation,
  reserves deterministic output paths, records the exact prompt/model/cost, and fences an
  ambiguous paid request from automatic duplicate charging.
- Migrations `20260730170000` through `20260730173000` → prompt create/promote and the
  durable redo state machine are applied forward-only to the linked database.

**Verified:**

- `380 passed` across 34 files; typecheck, lint, production build, `verify:isolation`, and
  linked Supabase database lint passed.
- Live prompt acceptance created/promoted/restored prompt
  `863e25ec-8508-4c6e-8202-a42fa4d9ec34` and proved atomic activation plus audit history.
- Live redo job `932dbeb1-ea9b-47c9-a89c-045dd03fc4b8` appended v2 for fixture
  `74b7dde8-d5e2-42cb-b7b4-787547b3a450`, cost `$0.078064`, made zero descriptor calls,
  retained original/v1/v2, left v1 selected, and stored the exact resolved prompt/model.
- Production browser read-back showed both ten-model selectors, prompt history and promotion
  controls, then showed original/v1/v2 and `Redo image` in the console. Evidence:
  `.artifacts/phase5-acceptance/evidence.json`, `prompts.png`, `versions.png`, and
  `redo-v2.png`.
- Deployment `dpl_55xkFtB2vLJ81sT275Y24aiZM1oB` is Ready at
  `https://qimati-loupe.vercel.app`.
- Cleanup passed, restored exact prompt `f2f08fe5-708c-4366-9826-18f5857c9f54`, removed
  five R2 objects and all temporary rows. Database read-back returned `0` intake rows,
  `0` redo jobs and exactly one current image prompt.

**Not finished / known broken:**

- Phase 5 has no remaining criteria. Phase 3C remains separately incomplete on its
  descriptor cost gate.
- Tracking, duplicate detection and daily Shopify reconciliation remain Phase 6.

**Surprises:** deployed SQL tests found PL/pgSQL name ambiguity and enum-assignment defects;
three small forward-only repair migrations fixed the live database without weakening tests.
The conservative D52 fence is necessary because a timed-out paid request can have an
unknowable billing outcome even when no result reached R2.

**Next session should start with:** read and execute the Phase 6 tracking, duplicate
detection and daily reconciliation plan.

---

## 2026-07-30 — Phase 5 curated model selection

**Goal this session:** add a small, useful model choice to each prompt stage without
changing the accepted defaults or exposing OpenRouter's full catalogue.

**Built:**

- `/prompts` → separate Descriptor and Image generation selectors, each with ten
  ordered choices from economical to premium. The current accepted models remain
  selected by default.
- `prompts.model` and `select_prompt_model` migration → model choice is versioned
  with the immutable prompt, audited, constrained to the curated list, and refused
  while an enhancement is in flight.
- Enhancement worker → each run now uses the model saved with its live prompt.
  Non-OpenAI image models receive a square request; square results are normalised to
  Loupe's 1280×1280 PNG contract and non-square results are refused rather than stretched.

**Verified:**

- `356 passed` across 31 files; typecheck, lint, production build,
  `verify:isolation`, and linked database lint passed.
- Migration `20260730160000_prompt_model_selection.sql` is applied.
- Database read-back still shows `openai/gpt-5.6-sol` and
  `openai/gpt-image-2` as the current models. No paid generation was run.
- Production browser read-back showed exactly ten choices in each separate selector,
  with the accepted defaults selected and both controls fitting cleanly in their prompt
  cards. Deployment `dpl_HNt4Et7rYgHCx1VTKxA9tB9jKtQS` is Ready at
  `https://qimati-loupe.vercel.app`.

**Not finished / known broken:**

- Phase 5 is not complete. Prompt-body creation/promotion, redo generation, version
  comparison, paid-call crash recovery, and live acceptance remain.
- Tracking remains Phase 6.

**Surprises:** image-edit providers do not share one request shape or fixed-price unit.
The curated list therefore shows compact provider hints, while Loupe keeps one output
contract.

**Next session should start with:** add append-only prompt-body creation and atomic
promotion, including required-token validation and audit events.

---

## 2026-07-30 — Phase 4 complete; Phase 5 prompt history started

**Goal this session:** settle the owner decisions, add custom material and safe product
descriptions, accept the owner’s unauthorised-account proof, and begin Phase 5.

**Built:**

- D49/D50 and migration `20260730150000` → Shopify store currency is authoritative;
  drafts now support either a controlled or one-off material plus an optional plain-text
  description override.
- Listing editor and publisher → the standard six-point description follows the material,
  can be edited/reset for a rare exception, is escaped into clean HTML, and is written
  alongside `custom.material`.
- `/prompts` → a protected Phase 5 screen showing the current Describe and Image prompts
  and every immutable prior version. No prompt or model setting changed.
- `PHASE-5-redo-version-history-prompts.md` → boundaries and twelve success criteria for
  append-only prompt promotion and cached-description redo.

**Verified:**

- Phase 4 criterion 2 passed: owner-supplied **No access** screen for
  `yashmiuky@gmail.com`; live `auth.denied` event `5964` records
  `not an active app_users row`. Screenshot retained at
  `.artifacts/phase4-acceptance/screenshots/unauthorised-denied.png`.
- Live test-store verifier passed every assertion and cleaned all 23 created products.
  `NK167` / `gid://shopify/Product/8033298972755` read back the standard 316L description;
  `NK189` read back `Sterling Silver` and the custom description override.
- Signed-in production browser opened `/prompts`, showed 2 Describe versions and 4 Image
  versions with exactly one current prompt in each, and navigated Console → Prompts.
- `345 passed` across 28 files; typecheck, lint, build, `verify:isolation`, and database
  lint passed. Migration applied. Deployment
  `dpl_13ixKkNT4QSx9jMJzJ11bAGioiLW` is Ready at
  `https://qimati-loupe.vercel.app`.

**Not finished / known broken:**

- Phase 5 is not complete. Prompt creation/promotion, redo generation, version comparison,
  paid-call crash recovery and live test evidence remain.
- Tracking remains Phase 6. Live-store currency confirmation remains a Phase 7 manual
  cutover check.

**Surprises:** Shopify stores equivalent list HTML with line breaks between tags. The live
verifier now ignores only inter-tag whitespace while still comparing the complete escaped
HTML. No paid enhancement call was made.

**Next session should start with:** add append-only prompt creation and atomic promotion,
including required-token validation and audit events.

---

## 2026-07-30 — Phase 4 queue counters now open real views; Tracking and Prompts remain scoped to Phases 6 and 5

**Goal this session:** respond to owner feedback that Ungrouped and Listed looked clickable
but did nothing, and make the future Tracking and Prompts labels unambiguous.

**Built:**

- `ConsoleScreen`, `StatPill`, `QueueGrid` → the header now has keyboard-accessible
  Pending, Ungrouped, Listed today, Needs attention (when non-zero), and Drafts controls.
  Black is the selected view; each click changes the queue heading, count, rows and empty
  state rather than acting as a decorative counter.
- `queue.ts`, `queue-view.ts`, console types → the queue snapshot now includes published
  drafts from the current Asia/Kolkata day. Listed cards retain their photograph, SKU and
  category and open the existing editor in a view-only state; they cannot be edited,
  detached, saved or published again from that view.
- `Sidebar` → Tracking and Prompts now carry visible `Phase 6` and `Phase 5` labels plus
  explanatory accessible text. Their full screens remain deliberately out of Phase 4;
  no placeholder screen is presented as a working feature.
- `console-queue-view.test.ts` → six focused assertions cover every filter and the exact
  Jaipur day boundary.

**Verified:**

- Production deployment `dpl_GEdHJT9dcFwrLUGGHwvjvMZKy23y` is Ready and aliased to
  `https://qimati-loupe.vercel.app`.
- In the signed-in production browser, clicking `0 ungrouped` selected the pill, changed
  the heading/listbox to `Ungrouped`, and showed its specific empty state. Clicking
  `0 listed today` did the same for `Listed today`. The sidebar exposed the Phase 6/5
  scope labels, the 1180×768 layout had no overflow, and the browser console had no errors.
- The live read model query returned `pending 0 · ungrouped 0 · drafts 0 · listed today 0`;
  the acceptance fixtures have already been cleaned, so an empty production grid is the
  correct current state. The populated view is covered by the pure filter test.
- `340 passed`; typecheck, lint, production build and `verify:isolation` passed. One
  pre-existing remote-DB concurrency test flaked while verification jobs accidentally
  overlapped, passed immediately alone, then passed in the clean serial 340-test run.

**Not finished / known broken:**

- Phase 4 remains NOT complete: criterion 2 still needs a genuinely unauthorised Google
  account, and the D6 description/theme and test-store currency decisions remain open.
- Tracking is still Phase 6 and prompt management is still Phase 5. Implementing either
  now would be a roadmap/scope change, not a repair to the Phase 4 console.

**Surprises:** the former `listed today` number was calculated from the Vercel runtime's
local midnight. The list now uses Jaipur midnight explicitly, matching the operator-facing
date and remaining stable across deployment regions.

**Next session should start with:** obtain the owner's description and currency decisions,
or explicitly reprioritise Phase 5/6 if Prompt management or Tracking should be built next.

---

## 2026-07-30 — Phase 4 live acceptance and cleanup passed; NOT complete on criterion 2 and two business decisions

**Goal this session:** implement the owner’s `NEWEST` requirement and Save Draft feedback,
then demonstrate every remaining Phase 4 criterion in order without touching the live
store or the Phase 3C model/prompt configuration.

**PHASE 4 IS NOT COMPLETE.** Criteria 1 and 3–18 now pass with retained evidence.
Criterion 2 still needs a real Google account that is absent from `app_users`; the only
account available in the browser was the authorised owner. Two owner decisions also remain
unanswered: keep D6 and change the theme, or reverse D6 and write per-product descriptions;
and whether the USD test store should change currency or deliberately remain mismatched
until an INR cutover precondition.

### Built and corrected

- Live catalogue read-back confirmed the exact always-on tag is **`NEWEST`** (all caps) on
  Necklace 970, Earrings 453, Chain Bracelet 353 and Anklets 087. `NEWEST_TAG` now sits
  beside `PRODUCT_TYPE` in `publish-product.ts`, so every publish path writes the category
  tag plus `NEWEST`; Phase 2 and Phase 4 verifiers assert the exact casing.
- Shopify rejected a generated PNG selected from a JPEG source because Loupe reused the
  intake filename extension. `filenameForStorage()` now derives the declared extension from
  the selected R2 object. The regression is covered in `shopify-product-images.test.ts`.
- The Phase 4 harness now selects fixtures that are still `enhanced` and ungrouped at
  runtime rather than by seed index. Its cleanup is resumable, detects already-absent
  Shopify/Drive objects, and checks every database deletion error.
- Save Draft is labelled and visibly moves through `Saving…` to `Saved`. Browser evidence
  showed the draft tile appear while the NK counter stayed unchanged.
- Visual acceptance found that the successful-publish notice was discarded when the editor
  became empty. The empty state now retains its notice. Keyboard acceptance then found that
  focus advanced by an obsolete numeric tile index; it now resolves the next photograph by
  stable intake ID.

### Live acceptance evidence — criteria 4 and 9–14

`PHASE4_LIVE_ACCEPTANCE=I_UNDERSTAND_THIS_PUBLISHES_TO_THE_TEST_STORE npm run
verify:phase4 -- accept` completed with `failures: 0`. Evidence is retained at
`.artifacts/phase4-acceptance/acceptance.json`.

```text
criterion 4   signed thumbnail 200; 1-second URL expired 403; unsigned request 400;
              20 thumbnails returned
criterion 9   images/material/price/stock all blocked together; NK counter unchanged
criterion 10  gid://shopify/Product/8033090109523 · NK138
              Necklace 138 (Adjustable) · ACTIVE · Jewellery
              tags Necklace + NEWEST + loupe-phase4-acceptance
              material 316L · price 750.00 · stock 12 · weight 0 g
              Gold/Silver · 3 selected media in draft order
criterion 11  retry reused NK138, handle, product ID and all media IDs; one product
criterion 12  gid://shopify/Product/8033091190867 · NK139
              two concurrent submits: one success, one PublishInProgressError;
              one product and one image
criterion 13  every Shopify alt matched its own cached source description;
              zero describe events
criterion 14  three Drive moves followed database publication; repeat was a safe no-op;
              forced 403 left the product published and readable
```

The separate Phase 2 live verifier also passed with a product carrying
`NEWEST`, `Necklace` and `loupe-test`; its concurrent, retry and override products were
deleted by `--cleanup-all`.

### Authentication and keyboard evidence

- **Criterion 1 passed.** `lakhira.studio@gmail.com` completed the real Google chooser,
  reached `/console`, survived refresh, signed out to `/login`, then signed in again.
  `auth.signed_in` and `auth.signed_out` events both carry that exact actor.
- **Criterion 2 remains unproven.** No second Google account was available. Do not add one
  to `app_users`; the required proof is a real absent account reaching Access denied,
  writing `auth.denied`, receiving no Loupe session, and failing a protected action.
- **Criterion 16 passed in a real Playwright Chromium session.** Tab reached the roving
  queue, Arrow keys moved to a photograph, Space selected it and focused price,
  Shift+Tab reached category, Enter/Space selected category and material, Enter in the
  colour field added `Rose Gold` without publishing, Escape cleared an in-progress
  selection, and Enter in price published. NK142 then advanced focus to the next ungrouped
  tile, `phase4-density-06.png`. Computed focus treatment was the required 2px black ring
  (price uses the equivalent 2px inset shadow).

### Visual acceptance — criterion 17

Compared against `docs/DESIGN.md` and `design/console-mockup.html`. The desktop and
1180×768 laptop layouts preserve the monochrome chrome, photograph-only colour, pill
geometry, 24px cards, 16px tiles, black feature card and sticky actions without horizontal
overflow. Tracking and Prompts deliberately remain grey Phase 6/5 labels rather than dead
links.

```text
.artifacts/phase4-acceptance/screenshots/desktop-20-tile-queue.png
.artifacts/phase4-acceptance/screenshots/desktop-multi-image-draft.png
.artifacts/phase4-acceptance/screenshots/laptop-multi-image-draft.png
.artifacts/phase4-acceptance/screenshots/validation-error.png
.artifacts/phase4-acceptance/screenshots/keyboard-publish-success.png
```

### Cleanup and production restoration — criterion 18

The first cleanup exposed two harness defects rather than being treated as green: NK113’s
UI-created draft ID was absent from the receipt, so one remaining image join made the whole
intake delete fail; and Drive files created in the owner’s My Drive can be moved but cannot
be trashed by the service account. The exact five files were selected in the owner’s
authenticated Drive UI and moved to Trash. The corrected, resumable cleanup then passed:

```text
Shopify       6 recorded Phase 4 products absent, including NK113 and NK138–NK142
Drive         5 exact fixture IDs trashed
database      26 intake rows and 8 drafts deleted; 0 remain
R2            15 recorded objects deleted; 0 remain
cron          4/4 Loupe jobs active; latest runs succeeded
empty ticks   watch/reconcile/sweep/enhance all HTTP 200
enhance tick  claimed=0 · enhanced=0 · descriptionCalls=0
```

No live-store write or configuration change occurred. `SHOPIFY_STORE_DOMAIN` remained
`qimti.myshopify.com`; Phase 7 still owns live cutover.

A final audit query exposed a third cleanup defect: the acceptance actor is the real owner
email, `lakhira.studio@gmail.com`, and cleanup also deleted events with that actor. That
removed the real `auth.signed_in` / `auth.signed_out` rows which had been read back before
cleanup, not just fixture events. They were not fabricated back into the audit table. The
broad actor deletion is removed; cleanup now deletes events only by the exact recorded
fixture entity IDs. Criterion 1’s pre-cleanup evidence remains recorded above, but the live
database no longer contains those two historical authentication rows.
The loss itself is now auditable as event `5212`, `phase4.cleanup.audit_loss`, actor
`script:phase4-cleanup-remediation`; it states that the historical rows were not recreated.

### Final quality evidence

```text
tests                    334 passed, 26 files
typecheck / lint / build passed
verify:isolation         all six server secrets absent; client server-only import refused
supabase db push dry-run remote database up to date
supabase db lint         no schema errors
production deployment    dpl_3x9aKdzfW3J8XVqqoMSc8syXQEB3 · READY
                         https://qimati-loupe.vercel.app
```

Phase 3C remains **not complete**. No model, reasoning, image size/quality, prompt or
presentation-class value changed, and the paid Phase 3C set was not rerun.

**Next session should start with:** have the owner answer the D6/theme and test-store
currency questions, then use any second Google account (kept absent from `app_users`) to
demonstrate criterion 2. Record any D6 reversal as a new numbered decision; only after that
evidence may Phase 4 be marked complete.

---

## 2026-07-30 — Phase 4 built and deployed; NOT complete, three business gaps found in operator testing

**Goal this session:** record the description-model deferral, then build the authenticated
listing console and prove every Phase 4 success criterion.

**PHASE 4 IS NOT COMPLETE.** The console is built, deployed and demonstrably publishes a
correct product to the test store, but the acceptance harness has not been run, most
criteria are unverified, and operator testing surfaced three requirements the build does
not meet.

### Decisions recorded first, in their own commit

D43 defers description-model selection and cost optimisation past Phase 4. Phase 3C stays
**not complete** (criterion 17 still failed), `DESCRIBE_MODEL` and every other model,
prompt and provider value is unchanged, and the Gemini shortlist remains evidence only.

D44–D48 record the choices this phase had to make: a direct Google OAuth client rather than
Supabase Auth, the image requirement enforced in TypeScript only, the publish lease, the
recorded Shopify media id, and the alt-text rules.

### Built

- `20260730140000_phase_4_listing_console.sql` → `create_product_draft`,
  `attach_intake_file`, `detach_intake_file`, `save_product_draft`, `begin_draft_publish` /
  `end_draft_publish`, `record_shopify_media`, `record_drive_housekeeping`, and an extended
  `mark_draft_published` that also publishes the intake rows and counts colour usage.
- `20260730141000_fix_save_draft_colour_ambiguity.sql` → forward fix; `plpgsql_check` found
  `name` ambiguous between `unnest(p_colours) as name` and `colours.name` (42702).
- `src/lib/auth/*` → Google OAuth with PKCE, an HMAC-signed session cookie, and an
  `app_users` lookup re-run on every protected surface.
- `src/lib/console/*` → queue read model, presigned R2 access, mutations, money parser,
  identity preview, injectable publish and Drive housekeeping.
- `src/components/console/*`, `/login`, `/console`, `/console/drafts/[draftId]` → the
  operator surface, shadcn/ui themed to the DESIGN.md tokens.
- `scripts/verify-phase4-live.ts` → seed / accept / cleanup harness. **Written and
  typechecked, never run past `seed`.**

### Verified

```text
tests                    332 passed (332), 26 files
typecheck / lint / build passed
verify:isolation         service role, Shopify, Drive, cron, OAuth secret and session
                         secret all absent from client assets; the server-only import
                         still fails the build from a client component
supabase db lint         No schema errors found
production deployment    https://qimati-loupe.vercel.app · READY
```

Proved against the deployed database, in `tests/console-drafts.sql.test.ts`:

- **the grouping race** — two concurrent `create_product_draft` calls for one photograph:
  one wins, the loser raises 55000 and its draft rolls back entirely;
- **the save race** — a stale `updated_at` is refused and the newer value survives;
- **the publish lease** — a second publish is refused while one is in flight, an expired
  lease is reclaimable, and a stale token cannot release its replacement's lease;
- category pinned once reserved (D27), Nose Pins refused for an unconfirmed tag (D23),
  intake rows published in the same transaction as the draft, a published draft refusing to
  be dismantled, and Drive housekeeping never touching `status`.

`tests/console-preview.test.ts` proves the preview agrees with the deployed
`reserve_draft_identity()` for **every** configured category, that a hundred previews move
no counter, and that saving moves no counter.

### The one real end-to-end publish — done by the operator, not by the harness

```text
Shopify product   gid://shopify/Product/8033052557395
title             Necklace 113          handle   necklace-113
SKU               NK113                 tag      Necklace
product_type      Jewellery             status   ACTIVE
custom.material   316L                  weight   0 g
price             125.00                stock    12
media             1 · alt = the 454-character cached description, verbatim
Drive             phase4-necklace.png moved to /Processed at 08:35:17Z
```

The event trail is complete and correctly attributed to `lakhira.studio@gmail.com`:
`intake.grouped` → `draft.created` → `draft.saved` → `publish.started` →
`publish.reserved` → `publish.media_recorded` → `intake.published` → `publish.published` →
`drive.processed`.

### Three gaps found by operator testing — none of them fixed

1. **No description on the product.** Correct per D6 as built — Loupe writes
   `custom.material` and the six bullets are supposed to render from the theme — but the
   theme has never been changed to read `product.metafields.custom.material` (CONTEXT.md
   open question 5). The product therefore ships with no description at all. Either the
   theme changes or D6 does; this needs a business decision, not a code change.
2. **Price shows in USD.** `shop.currencyCode` on `qimti.myshopify.com` is **USD**, so
   `125.00` renders as $125.00. Loupe writes a currency-less decimal string and Shopify
   applies the store currency, so this is store configuration, not a Loupe bug — but it is
   CONTEXT.md open question 3 and must be settled before cutover.
3. **The `Newest` tag is missing.** New requirement, stated 2026-07-30: every product needs
   `Newest` alongside its category tag. Not implemented. `CLAUDE.md` now records it, with
   the warning to confirm the exact casing against a live product first.

### One reported bug that is not a bug

"Save Draft does not add the product to draft" — the database disagrees. `draft.created`
and `draft.saved` were both written at 08:33, four seconds apart, before any publish, and
the draft persisted. What is actually wrong is the interface: Save Draft is an icon-only
button (`◷`) with a tooltip and **no confirmation of any kind**, so a successful save looks
identical to a dead button. That is a real defect in the operator surface; it is not a
persistence defect.

### Not finished / known broken

- `npm run verify:phase4 -- accept` has never been run. Criteria 4, 9, 10, 11, 12, 13 and
  14 are therefore unproven by the harness, even though criterion 10's substance was
  demonstrated by hand above.
- Criteria 1 and 2 are unproven: sign-in reached Google's consent screen and stopped there.
  The unauthorised-account refusal has never been exercised against the running app.
- Criteria 16 (keyboard) and 17 (visual acceptance screenshots) are unproven.
- The three gaps above.
- 20 seeded intake rows, 4 Drive files still in RAW, ~60 R2 objects and one real Shopify
  product (`8033052557395`, NK113) are all still present. **Nothing has been cleaned up.**
  `.artifacts/phase4-acceptance/fixtures.json` lists everything except that product.
- The NK counter is at 113. Phase 2's `NK090` draft row also predates this session.

### Surprises

- **A wrong Google client secret is invisible until the last step.** The authorization
  redirect only uses the client id, so Google's own sign-in page appears, the operator signs
  in successfully, and the failure arrives at the token exchange as an opaque 401 that reads
  like a Google outage. `/health` now probes the client with a deliberately invalid code:
  `invalid_grant` means the pair is accepted, `invalid_client` means it is not.
- **The Shopify credentials were never set on Vercel.** Production had no
  `SHOPIFY_CLIENT_ID` or `SHOPIFY_CLIENT_SECRET`, so the deployed app could not have
  published at all. Added this session along with the Phase 4 variables.
- **Position-repairing Shopify media is only safe when NOTHING is recorded.** The first cut
  repaired a mixed set by position; but the usual way an image loses its media id is the
  operator swapping which version to publish, so that would have silently republished the
  version they had just rejected. Caught by a test, narrowed to all-or-nothing.
- **`image_versions` cannot be cleaned up in either obvious order** — RESTRICT from
  `product_draft_images`, CASCADE from `intake_files`, and a CHECK that requires a draft
  while grouped. The join table has to be cut first. The first cleanup did not check the
  error, so fixtures survived, the counter was reset beneath them, and the next run collided
  on `reserved_sku`.

**Next session should start with:** `docs/phases/PHASE-4-HANDOFF.md`, which lists the exact
state, the three gaps and the remaining criteria in order.

---

## 2026-07-30 — Phase 3C implemented and visually verified; criterion 17 blocks completion

**Goal this session:** add bounded category-aware composition to the durable two-call
worker, prove the new behavior against five real products, clean production fixtures, and
evaluate cheaper description models without silently changing production.

**PHASE 3C IS NOT COMPLETE.** Criteria 15, 16 and 18 pass. Criterion 17 explicitly fails:
the five accepted `openai/gpt-5.6-sol` descriptions cost $0.014816–$0.016851 each, above
the required `< $0.006` target. Production remains on the current model.

**Built:**

- `docs/CONTEXT.md` → preserved the business and operating context before implementation
  in its own commit.
- `src/lib/enhance/presentation.ts` → exact six-member vocabulary, strict structured-output
  parser, exhaustive application-owned composition map and deterministic `flat-curve`
  fallback.
- `src/lib/enhance/openrouter.ts`, `prompt.ts`, `worker.ts`, repository adapters → strict
  JSON describe results, two-token prompt resolution, cached presentation reuse, queryable
  fallbacks and the existing bounded retry/lease/R2 recovery guarantees.
- `20260730100000_phase_3c_category_aware_composition.sql` → enum and audit columns, exact
  prompt versions, fenced structured cache/fallback RPCs and service-role-only grants.
- `verify-phase3c-live.ts` and `cleanup-phase3c-live.ts` → guarded resumable live evidence,
  cached redo, rollback-only fallback proof, contact sheet and exact cleanup receipt.
- `evaluate-description-models.ts` → isolated, description-only candidate evaluation with
  raw output, wire contract and actual provider-reported cost; it has no production write
  path and does not change `DESCRIBE_MODEL`.

### Criterion 15 — pass: five products, four classes, exact prompts

All five rows stored a valid model-selected class with
`presentation_fallback=false`. Every exact code-owned composition paragraph occurred once,
every unresolved-token list was empty, and each stored `prompt_text` equalled the prompt
sent to the provider.

| file | class | generation attempts | description USD | image USD |
|---|---|---:|---:|---:|
| `phase3b-01.png` | `flat-curve` | 3 | 0.015801 | 0.078064 |
| `phase3b-02.jpg` | `flat-arc` | 2 | 0.015351 | 0.077944 |
| `phase3b-03.jpg` | `flat-arc` | 1 | 0.016851 | 0.078000 |
| `phase3b-04.png` | `tray-grid` | 2 | 0.016821 | 0.078272 |
| `user-earrings-source.png` | `pair-upright` | 2 | 0.014816 | 0.076248 |

Provider request values were unchanged across the set:

```text
describe  openai/gpt-5.6-sol · reasoning minimal/excluded · max 256 · stream false
image     openai/gpt-image-2 · 1280x1280 · medium · n=1
input     typed image_url data-URL object for both stages
```

The complete resolved prompt for one product in each represented class follows.

#### `flat-curve` — `phase3b-01.png`

```text
A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
A single necklace in polished yellow-gold-tone metal, forming a long, gently curved drop with a centered pendant-like dangle. Round-cut stones in blue, red, green, black and pale pink are individually bezel-set at intervals along the lower chain, with a deeper red stone suspended at the centre. The fine cable-link chain is decorated with spaced polished gold-tone beads, creating an alternating arrangement of coloured bezels and small spherical drops. The surfaces are smooth and reflective, with no visible engraving.

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
no risers, no boxes, nothing touching the jewellery.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
Lay the piece flat in a soft open curve, the pendant or centre feature toward the
lower centre of the frame and the chain sweeping naturally above it. Clasp visible.

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.
```

#### `flat-arc` — `phase3b-02.jpg`

```text
A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
A single flexible chain bracelet in polished gold-tone metal, forming a slender open arc when laid flat. It has no visible stones. The bracelet combines a smooth, closely woven flat snake chain with an outer row of elongated rectangular paperclip links. Several links feature narrow ribbed or ridged inset sections, creating an alternating open and textured pattern. A lobster-claw clasp secures one end, while the opposite end has an adjustable extension chain finished with a slim bar-shaped terminal.

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
no risers, no boxes, nothing touching the jewellery.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
Lay the piece flat in a relaxed open arc, clasp and extender chain visible and
naturally placed rather than tucked away.

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.
```

#### `tray-grid` — `phase3b-04.png`

```text
A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
An assortment of multiple separate rings in varied, non-matching designs. The rings have polished gold-tone metal bands with slim, curved silhouettes, including linked hearts, interlocking circles, scalloped motifs and straight gemstone rows. Faceted stones in clear, blue, pink, red, green, orange, purple and yellow tones appear in round, oval, rectangular, heart and teardrop cuts. They are arranged as central solitaires, clustered accents, halos, graduated rows and multicoloured sequences, secured mainly by prong and bezel-style settings. Some bands feature openwork, beaded edges and repeating decorative links.

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
no risers, no boxes, nothing touching the jewellery.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
Keep every item visible and evenly spaced in aligned rows at consistent scale, the
whole set square to the frame. Do not crop any item. Do not restage into a scene.

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.
```

#### `pair-upright` — `user-earrings-source.png`

```text
A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
A matching pair of stud drop earrings in polished gold-tone metal. Each earring has a compact two-part silhouette, with an oval upper stud and a rounded teardrop pendant below. The upper oval is densely pavé-set with small, round-cut, colourless stones. The lower section holds a milky white, iridescent teardrop cabochon within a slim gold-tone bezel. A short concealed connection joins the two sections, allowing the lower element to hang beneath the stone-set stud.

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
no risers, no boxes, nothing touching the jewellery.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
Show both pieces upright and front-facing, evenly spaced and symmetrically arranged
side by side at identical scale and height. Balanced, not mechanically duplicated.

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.
```

### Criterion 16 — pass: malformed and invented-class fallback

A linked production transaction created and claimed one malformed-JSON fixture and one
invented-`ring` fixture, set each to attempt four, and called the deployed
`record_description_failure()` path. Both returned:

```text
status                       enhancing
attempts                     5
proceed_without_description  true
presentation_class           flat-curve
presentation_fallback        true
```

Reasons were respectively `description_invalid_json` and
`description_presentation_invalid`. The exact raw provider strings remained in
`description_error_detail`; `description.missing` events recorded
`model_composition_prose_accepted=false`. Each fallback prompt contained the exact
`flat-curve` code-owned paragraph, no PRODUCT block, no unresolved token and no invented
`ring` prose. The transaction was rolled back after evidence capture.

### Criterion 17 — failed: current-model description cost

```text
five accepted descriptions  $0.079640 total
mean                         $0.015928
range                        $0.014816–$0.016851
required                     every call < $0.006
```

The measured $0.016851 anklet call remains valid evidence. The result is not reinterpreted:
criterion 17 fails and the phase cannot close on the current model.

### Criterion 18 — pass: contact sheet and catalogue-grid review

The retained review sheet is:

```text
.artifacts/phase3c-acceptance/before-after-contact-sheet.png
```

All five results use the same ivory-champagne catalogue treatment, centred square framing,
controlled shadows and readable product edges. The necklace follows a soft open curve; both
flexible pieces use open arcs with fittings visible; the earrings remain a symmetric matched
pair. The tray source and Phase 3C output both contain **87 rings** in the same row counts:
`9/9/9/8/9/9/8/8/9/9`. Nothing is cropped or collapsed to a single invented item.

### Retry, cached redo, fencing and cleanup

- The first live run completed the anklet, then OpenRouter returned HTTP 403 “key total
  limit exceeded” for the other four. Their existing rows and the completed anklet were
  preserved. After the limit changed, the resumable verifier made no additional anklet
  describe call and completed the four deferred rows with the same models.
- A final cached replay claimed `phase3b-01.png`, reused its structured description and
  immutable generated R2 object, completed in 6.160 s and recorded
  `extraDescribeCalls=0`, `extraImageCalls=0`.
- Existing deployed-SQL and worker gates still prove stale-token rejection, SKIP LOCKED
  claims, retry backoff and immutable conflict handling.
- Cleanup moved five Drive uploads to Trash and verified zero remained in Raw; deleted five
  intake rows, ten image-version rows by cascade, 32 events and 15 R2 objects; and verified
  zero matching database/R2 state remained. Local evidence was retained.
- All four cron jobs are active again. Authenticated production ticks returned:

  ```text
  enhance    HTTP 200 · claimed=0 · enhanced=0 · descriptionCalls=0
  reconcile  HTTP 200 · scanned=0 · inserted=0
  ```

### Isolated cheaper-model evaluation

No production state or configuration changed. Five vision-capable candidates saw the same
prepared source images and exact describe prompt.

| candidate | strict JSON | classes | five-call cost | factual review | image gate |
|---|---|---|---:|---|---|
| GPT-5.4 Mini | fail | fail | $0.010254 | fail: rigid bracelet claim; tray truncated | not run |
| GPT-5.4 Nano | pass | pass | $0.0028234 | fail: rigid/snake-like chain misdescription | not run |
| Gemini 3.1 Flash Lite Preview | pass | pass | $0.00283525 | fail: guessed CZ/post and mentioned display tray | not run |
| Gemini 3 Flash Preview | pass | pass | $0.005572 | pass; flat-chain wording flagged for image review | not run |
| Claude Haiku 4.5 | fail | fail | $0.011962 | fail: fenced JSON and guessed stones/fittings | not run |

Each individual provider-reported candidate cost was below $0.006. Gemini 3 Flash Preview
is the only description-only shortlist: its five factual paragraphs are acceptable against
the same source/baseline review, but its flat-chain terminology is called out for the image
gate. No candidate passes all required gates because no image candidate run was made.
Production remains `openai/gpt-5.6-sol`. A candidate run requires an explicit decision,
updated evidence and a fresh comparable five-product acceptance proving jewellery fidelity
and the 87-item tray count.

Raw candidate evidence:

```text
.artifacts/phase3c-description-eval/evidence-batch-1.json
.artifacts/phase3c-description-eval/evidence.json
```

### Final quality evidence

```text
production deployment    dpl_CicCH1uwcDP1TgyVT8Hqbx3ct8KM · READY
production alias         https://qimati-loupe.vercel.app
test files               19 passed (19)
tests                    243 passed (243)
typecheck                passed
lint                     passed
build                    passed
secret isolation         passed
linked migration dry-run remote database is up to date
linked database lint     No schema errors found
```

**Not finished / known broken:**

- Criterion 17 fails; Phase 3C must not be marked complete.
- Gemini 3 Flash Preview passed the description-only gates, but no cheaper candidate has
  passed the required end-to-end image gate.

**Surprises:**

- The OpenRouter application key had a total limit and stopped the first acceptance run
  after one complete product. The resumable harness preserved that row and continued the
  original four instead of creating replacements.
- The live prompt names are descriptive version names, not `image.default`; the verifier
  now resolves the exact two Phase 3C names and can finish from entirely cached state.
- Cheap models can pass JSON, cost and class checks while still introducing small factual
  errors that are dangerous for an image-edit prompt. Machine gates alone are insufficient.

**Next session should start with:** explicitly approve or reject a fresh isolated
five-product image comparison for Gemini 3 Flash Preview. Do not change production before
that run proves jewellery fidelity and the 87-item tray count.

---

## 2026-07-29 — Phase 3B complete: durable two-call enhancement and live A/B

**Goal this session:** build the crash-safe two-call enhancement worker, prove every Phase
3B success criterion against production, and decide from a five-product A/B whether the
cached description stays in the image prompt.

**✅ PHASE 3B IS COMPLETE.** The production worker is deployed at
`https://qimati-loupe.vercel.app/api/cron/enhance`; all four cron jobs are active. It
generates 1280×1280 medium images and never moves a Drive file to Processed.

**Prerequisites proved before implementation:**

```text
supabase db push:
  connected with the reset database password; migrations applied normally

/health:
  HTTP 200
  database reachable: true
  all tables readable: true
  GOOGLE_SERVICE_ACCOUNT_JSON valid: true

pg_cron / pg_net:
  both extensions installed; migrations and runtime scheduling succeeded
```

**Built:**

- `20260729132000_phase_3b_two_call_enhancement.sql` → prompt kinds, cached description
  state, description audit flags, fenced description writes/failures, and idempotent
  original/generated completion.
- `20260729132719_fix_enhancement_completion_ambiguity.sql`,
  `20260729132857_fix_enhancement_error_class_enum.sql`,
  `20260729132943_fix_description_failure_status_enum.sql`, and
  `20260729145000_fix_completion_status_enum_lint.sql` → forward-only fixes found by live
  completion tests and `plpgsql_check`.
- `20260729145500_stop_description_cost_retries.sql` → an over-ceiling describe response
  degrades immediately on attempt 1 instead of repeating the same paid misconfiguration;
  final linked database lint has zero findings.
- `src/lib/enhance/` → strict env configuration, exact prompt resolution, 1024 px input
  preparation, 1280×1280 output verification, OpenRouter describe/image clients,
  deterministic immutable R2 storage, fenced repository and bounded worker.
- `POST /api/cron/enhance` and the fourth `loupe-image-enhance` pg_cron job → at most two
  claims per invocation, a 240-second budget, and the existing Vault bearer-secret pattern.
- Google Drive server client → original-byte downloads; no Processed-folder move exists in
  this phase.
- `.env.local.example` → `DESCRIBE_MODEL=gpt-5.6-sol`,
  `DESCRIBE_REASONING_EFFORT=minimal`, `INJECT_DESCRIPTION=true`,
  `IMAGE_MODEL=gpt-image-2`, `IMAGE_SIZE=1280x1280`, `IMAGE_QUALITY=medium`,
  `$0.02` description and `$0.20` image ceilings.
- Contract, worker, schema, RLS and direct-Postgres tests → prompt bytes, provider request
  shape, retry/degradation, immutable recovery, cost failure, stale fencing and concurrent
  exactly-once processing.

**Verified — original Phase 3B criteria 1–9:**

1. Five real Qimati photographs produced these complete generated rows. All images were
   actual 1280×1280 PNGs; every thumbnail was below 50 KB.

| file | intake id | image version id | attempts | model | cost USD | selected | description |
|---|---|---|---:|---|---:|---|---|
| `phase3b-01.png` | `5174df7c-d7fd-4c4f-8e6f-31c0ffccde4e` | `4ecfb7f7-6fe4-4844-807a-c0fb25c39b8e` | 2 | `openai/gpt-image-2` | 0.078008 | true | injected |
| `phase3b-02.jpg` | `a3ec4e71-a068-4083-922d-8c5212756fe7` | `8d7a991b-3feb-4944-8e5e-62e7e757936a` | 1 | `openai/gpt-image-2` | 0.077920 | true | injected |
| `phase3b-03.jpg` | `fd98a715-b278-40b9-8b1f-c0d3c637eab8` | `cd560ed1-0647-4aec-a3b8-dd1aba6656cb` | 2 | `openai/gpt-image-2` | 0.077992 | true | injected |
| `phase3b-04.png` | `81cb814f-7494-4277-aa58-daf0b65913c8` | `9de573f0-d6bb-4e4c-8b5c-a8fdc0fc1f3a` | 1 | `openai/gpt-image-2` | 0.078184 | true | injected |
| `phase3b-05.png` | `3a16b141-29d3-4d20-b869-ff003563bb17` | `840fa3cc-25aa-4fba-9651-27d0fb09483e` | 1 | `openai/gpt-image-2` | 0.078176 | true | injected |

   Generated keys were `versions/{intake_id}/v1.png`; thumbnail keys were
   `versions/{intake_id}/v1_thumb.webp`. Thumbnail sizes were 16,390; 17,398; 18,366;
   39,114; and 41,560 bytes. Image total was **$0.390280** and mean
   **$0.078056**, below the $0.15 criterion.

2. **Fencing:** worker A claimed with token
   `452dc787-8852-4a31-8bc0-265f2c4badd7`, expired, was swept, and worker B reclaimed with
   `aa2d11ba-b4ef-4b5b-9512-6e2ed6436e7c`. B completed first. A's later completion was
   rejected with SQLSTATE `55000`:

   ```text
   complete_intake_enhancement: lease for intake_file ... is no longer current
   Hint: Discard this stale worker result; another worker may now own the row.
   ```

   The surviving row still had one generated version, model `control/winning-worker`,
   prompt `winning worker exact prompt`, selected `true`, cost `0.010000`.

3. For all five files, Drive MD5 equalled the R2 original MD5 byte-for-byte. Repeating the
   immutable put returned `created=false`. A deliberate different-byte overwrite raised
   `r2_immutable_conflict`; SHA-256 stayed
   `585a5b5f1171a5183309f469bd69f9b34802d1bba9f5dabef91a2fe12dabc081`
   before and after.
4. A forced provider 429 on `phase3b-03.jpg` scheduled attempt 1 exactly one minute later.
   The due retry succeeded at attempt 2 for $0.077992 and made zero additional describe
   calls.
5. A forced content-policy failure landed in `failed`, `attempts=1`,
   `error_class=permanent`, with: “The image was rejected by the provider content policy.”
6. With the ceiling deliberately lowered to $0.01, a real $0.077192 generation was retained
   unselected, failed permanently at attempt 1, and recorded:

   ```text
   Image generation cost $0.077192 exceeded the $0.01 per-image ceiling.
   The version was retained for review and will not be retried.
   ```

7. A one-second presigned R2 URL returned HTTP 200 immediately and HTTP 403 after expiry.
8. Five concurrent production endpoint calls each claimed and enhanced a different real
   A/B row. The exact worker test also runs five workers over ten queued rows. At the
   evidence checkpoint the database had ten harness intake rows, ten enhanced, ten
   generated v1 rows, and a maximum of one generated version per intake.
9. Spend was queryable only from stored actual values:

   ```text
   injected image total       $0.390280
   injected image mean        $0.078056
   five description calls     $0.075500
   non-injected image total   $0.385960
   non-injected image mean    $0.077192
   ```

**Verified — two-call amendment criteria 10–14:**

10. All five injected rows stored `product_description`, the exact resolved
    `prompt_text`, `description_injected=true`, and the actual description cost. One
    complete stored example follows.

    Product description:

    ```text
    A single necklace in polished gold-tone metal, forming a delicate, elongated U-shaped silhouette. Round-cut stones in turquoise blue, vivid pink, green, black and pale pink are individually bezel-set in small circular drops and spaced along the lower and side sections, with a deeper pink stone forming the central pendant. The fine cable chain is decorated with polished gold-tone bead drops in alternating sizes between the stone settings. The arrangement is broadly symmetrical, with the coloured bezels and beads suspended from short connecting loops.
    ```

    Exact stored resolved prompt:

    ```text
    A single hero product photograph for an e-commerce jewellery catalogue.

    PRODUCT
    A single necklace in polished gold-tone metal, forming a delicate, elongated U-shaped silhouette. Round-cut stones in turquoise blue, vivid pink, green, black and pale pink are individually bezel-set in small circular drops and spaced along the lower and side sections, with a deeper pink stone forming the central pendant. The fine cable chain is decorated with polished gold-tone bead drops in alternating sizes between the stone settings. The arrangement is broadly symmetrical, with the coloured bezels and beads suspended from short connecting loops.

    SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
    display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
    it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
    branding that is not physically part of the jewellery. Present the piece as though
    photographed on its own. Where the item is a pair, show both, evenly spaced and
    symmetrically arranged side by side at the same scale and height — balanced, not
    mechanically duplicated.

    BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
    out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
    and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
    no risers, no boxes, nothing touching the jewellery.

    LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
    gentle warm fill from the front right, restrained rim light to separate polished edges from
    the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
    controlled specular points on faceted stones — no starbursts, no glitter, no blown
    highlights, no lens flare.

    SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
    piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
    objects, no dramatic contrast.

    COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame with
    even margins and clean negative space. Eye-level or very slightly elevated camera angle,
    straight-on frontal presentation. Preserve the angle and orientation of the piece as
    photographed — do not reposition, rotate or restage it. Keep this framing identical for
    every product.

    CAMERA — premium macro product photography with the visual character of an 85–100mm macro
    lens. The piece completely sharp front to back with crisp micro-detail; the background
    transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
    realistic optical depth, accurate textures. The result must look like a real photograph —
    not a 3D render, illustration, painting or AI image.

    FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
    the piece exactly as photographed: form, proportion, stone shape and placement, setting
    style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
    colour must all match the source. Do not add sparkle, stones, links, engraving or
    decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
    part of it. Where a detail is unclear in the source, reproduce it as-is rather than
    inventing it. Only the surroundings may change.

    DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
    packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
    wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
    design, distorted proportions, bent or melted metal, duplicated components, floating
    jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
    excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
    grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.
    ```

11. With `INJECT_DESCRIPTION=false`, all five stored prompts had
    `description_injected=false`, no placeholder, `strpos(prompt_text, 'PRODUCT') = 0`, and
    began with exactly one blank line before SUBJECT. Exact stored prompt:

    ```text
    A single hero product photograph for an e-commerce jewellery catalogue.

    SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
    display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
    it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
    branding that is not physically part of the jewellery. Present the piece as though
    photographed on its own. Where the item is a pair, show both, evenly spaced and
    symmetrically arranged side by side at the same scale and height — balanced, not
    mechanically duplicated.

    BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
    out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
    and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
    no risers, no boxes, nothing touching the jewellery.

    LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
    gentle warm fill from the front right, restrained rim light to separate polished edges from
    the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
    controlled specular points on faceted stones — no starbursts, no glitter, no blown
    highlights, no lens flare.

    SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
    piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
    objects, no dramatic contrast.

    COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame with
    even margins and clean negative space. Eye-level or very slightly elevated camera angle,
    straight-on frontal presentation. Preserve the angle and orientation of the piece as
    photographed — do not reposition, rotate or restage it. Keep this framing identical for
    every product.

    CAMERA — premium macro product photography with the visual character of an 85–100mm macro
    lens. The piece completely sharp front to back with crisp micro-detail; the background
    transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
    realistic optical depth, accurate textures. The result must look like a real photograph —
    not a 3D render, illustration, painting or AI image.

    FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
    the piece exactly as photographed: form, proportion, stone shape and placement, setting
    style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
    colour must all match the source. Do not add sparkle, stones, links, engraving or
    decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
    part of it. Where a detail is unclear in the source, reproduce it as-is rather than
    inventing it. Only the surroundings may change.

    DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
    packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
    wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
    design, distorted proportions, bent or melted metal, duplicated components, floating
    jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
    excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
    grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.
    ```

12. Re-running already-described `phase3b-01.png` incremented intake attempts from 1 to 2
    but left one generated row, the same image version/cost and the same $0.015460
    description ledger entry. OpenRouter key usage was **1.28418 before and after**:
    zero describe calls and zero provider spend on the recovered generation.
13. Four forced describe failures scheduled the normal backoff. The fifth returned
    `proceed_without_description=true` and still produced a real 1280×1280 image for
    $0.077192. The final rows recorded `attempts=5`, `description_missing_at` present,
    `description_injected=false`, `description_missing=true`, and no PRODUCT heading.
14. The same five sources were generated both ways: ten images total. Costs are in criterion
    9. The full contact sheet and five individual pairs are retained locally:

    ```text
    .artifacts/phase3b-acceptance/ab-contact-sheet.png
    .artifacts/phase3b-acceptance/pairs/phase3b-01-comparison.png
    .artifacts/phase3b-acceptance/pairs/phase3b-02-comparison.png
    .artifacts/phase3b-acceptance/pairs/phase3b-03-comparison.png
    .artifacts/phase3b-acceptance/pairs/phase3b-04-comparison.png
    .artifacts/phase3b-acceptance/pairs/phase3b-05-comparison.png
    ```

    Individual necklace/anklet arms were close. On the two ring-tray sources, disabling
    injection collapsed the photographed collection to one invented ring; injection
    retained a collection. D40 therefore keeps `INJECT_DESCRIPTION=true`.

**Cleanup and restored production state:**

```text
Drive Raw fixtures       10 moved to Trash; 0 left in Raw; none moved to Processed
R2 harness objects       30 deleted; 30 HEAD checks returned absent
database harness state   0 intake rows; 0 image versions/events
production env           INJECT_DESCRIPTION=true · image ceiling $0.20
cron                     watch/reconcile/sweep/enhance all active
production empty tick    claimed=0 · enhanced=0 · descriptionCalls=0
```

Local visual/evidence artifacts were deliberately retained; they are Git-ignored and are
the review record after live cleanup.

**Quality evidence:**

```text
Test Files  17 passed (17)
Tests       203 passed (203)
typecheck:  passed
lint:       passed
build:      passed
db lint:    No schema errors found
secret isolation: service role, Shopify, Drive and cron secrets absent from client assets
security advisors: informational RLS-with-no-policy only — intentional server-only deny
performance advisors: unused-index INFO only on a new/low-traffic database
```

**Not finished / known broken:**

- Nothing remains in Phase 3B.
- The operator UI, authentication and grouping/version-selection workflows remain later
  phases.

**Surprises:**

- OpenRouter's current Images API rejects bare data-URL strings in `input_references`; it
  now requires a typed `image_url` object. The client and contract test use the accepted
  wire shape.
- Direct live SQL exposed three PL/pgSQL ambiguities/enum-resolution issues that mocks
  could not. Forward migrations fixed them; the final linked lint is clean.
- Final cost-path review found that a successful but over-ceiling describe response still
  held a non-null result after entering the failure branch, which could have cached and
  injected rejected text. The worker now clears that result, the database degrades
  immediately without a second describe call, and both unit and deployed-SQL tests lock it.
- The same final review preserved retryability for database completion outages, persisted
  the provider-resolved model rather than merely the requested alias, and added a
  deterministic-R2 recovery test proving that a post-upload replay makes no second image
  call.
- `gpt-5.6-sol` description calls cost $0.014620–$0.015970 here, not the rough $0.004
  estimate, but all remained below the independent $0.02 ceiling.

**Next session should start with:** open the Phase 4 specification and build the authenticated
operator surface on top of the now-live intake and enhancement pipeline.

---

## 2026-07-29 — Phase 3B Step 0: 1280 medium path meets the cost gate

**Goal this session:** replace the foreign-looking marble prompt with the catalogue-matching
ivory-satin prompt, make image cost controls explicit, and prove one production-shaped
OpenRouter edit before any worker code.

**Built:**

- `20260729131000_replace_default_enhancement_prompt.sql` → archives the marble default and
  installs the exact ivory-champagne satin prompt as the sole live default, with its
  approximately-100-image catalogue provenance recorded in `events`.
- `.env.local.example` and live `.env` → explicit `IMAGE_SIZE=1280x1280`,
  `IMAGE_QUALITY=medium`, and `MAX_COST_USD_PER_IMAGE=0.20`. The business changed the
  output from the phase prompt's 1536×1536 and the first 1024×1024 proposal to 1280×1280.
- D5, D33 and D35 plus `CLAUDE.md` → catalogue-background reasoning, explicit
  configuration/cost guard, 1024 px input downscale, and measured Step 0 evidence.
- The throwaway probe read the live prompt and configuration, validated the input long
  edge, made one network call, saved the evidence, and was removed. It is not worker code.
- D19 needed no further change: fixed-rate shipping and the NULL/0 distinction were already
  settled correctly, and no weight cutover blocker remains.

**Verified:**

```text
supabase db push --linked --dry-run:
  connected; would apply only 20260729131000
supabase db push --linked --yes:
  20260729131000 applied successfully
final dry-run:
  Remote database is up to date

live database:
  live default prompts = 1
  name = Qimati ivory-champagne satin — catalogue fidelity
  body = exact approved satin prompt; no size/aspect-ratio text
  previous marble prompt archived
  prompt.default_replaced event records:
    source = inspection of approximately 100 live catalogue images
    marble rejected · sparkle removed · framing/fidelity added

live environment:
  IMAGE_SIZE=1280x1280
  IMAGE_QUALITY=medium
  MAX_COST_USD_PER_IMAGE=0.20
```

The one real OpenRouter request used `POST /api/v1/images`,
`openai/gpt-image-2`, the live satin prompt, and a 1024×1024 / 32,039-byte copy of
the real Qimati necklace:

```text
editing with input          YES — the returned satin scene retained the specific necklace
requested size              1280 × 1280
actual size                 1280 × 1280 PNG
requested quality           medium
prompt tokens               1,312
completion tokens           2,096
total tokens                3,408
actual cost                 $0.073376
cost source                 response usage.cost (exposed directly; not derived)
configured ceiling          $0.20
ceiling exceeded            no
round-trip latency          65.358 s
size honoured               yes, exactly
quality honoured            yes — accepted explicitly and produced the medium-tier
                             token/cost profile, far below the explicit-high probe
```

The earlier `$0.44116` result was **not** an `auto` default: its throwaway script explicitly
sent `quality: "high"` and `size: "2048x2048"`. Documentation was corrected rather than
preserving the new phase prompt's mistaken attribution.

Saved proof (Git-ignored, retained locally):

```text
.artifacts/phase3b-step0-1280-medium/input-necklace-1024.jpg
  1024×1024 · 32,039 bytes
.artifacts/phase3b-step0-1280-medium/gpt-image-2-1280-medium.png
  1280×1280 · 2,755,188 bytes
.artifacts/phase3b-step0-1280-medium/evidence.json
  request, live prompt, response headers, dimensions, tokens and exact cost
```

Quality evidence:

```text
Test Files  13 passed (13)
Tests       172 passed (172)
typecheck:  passed standalone
lint:       passed
build:      passed
db lint:    No schema errors found
git diff --check: passed
```

**Not finished / known broken:**

- The Phase 3B enhancement worker is intentionally **not started**. The requested
  architecture gate is complete and this session stops here.
- The attachment's later success criterion still says 1536×1536, but the business's newest
  instruction supersedes it with 1280×1280; D35 is the current decision.
- The $0.20 failure transition is specified and configured but not implemented here because
  it belongs to the worker that this gate explicitly forbids starting.

**Surprises:**

- The first local probe attempt never reached the network: an optional `X-Title` header
  contained an em dash, and Node rejected the non-ByteString header before opening a
  request. It was changed to ASCII; exactly one paid/network image call was made.
- Running standalone typecheck concurrently with `next build` briefly raced while Next
  regenerated `.next/types`. The build's TypeScript pass succeeded, and the standalone
  rerun after the build also passed.
- Medium at 1280×1280 cost $0.073376 and returned in 65.358 seconds, versus high at
  2048×2048 costing $0.44116 and taking 222.242 seconds.

**Next session should start with:** review the saved 1280×1280 satin result and, only after
business approval, authorise the Phase 3B worker at the D35 production settings.

---

## 2026-07-29 — Phase 3B Step 0: real OpenRouter image edit proved, worker deliberately not started

**Goal this session:** settle the fixed-shipping weight decision, seed the business-approved
default prompt, and de-risk the exact `gpt-image-2` input path before any worker code.

**Built:**

- `20260729125000_fixed_rate_shipping_weight.sql` → records that Qimati uses fixed shipping,
  so 0 g is the correct settled catalogue value while NULL stays unknown and blocks publish.
- `20260729130000_seed_default_enhancement_prompt.sql` → installs the exact approved prompt
  as the sole live default and records the three deliberate adaptations in an event.
- D19, D33, D34 and `CLAUDE.md` → remove weight from cutover blockers, define prompt
  provenance/versioning, and record the measured OpenRouter capability/cost/latency.
- A throwaway Step 0 probe read the live default prompt, sent one real Qimati necklace as
  one `input_references` data URL, saved the response evidence, and was then removed. It is
  not worker code.

**Verified:**

```text
supabase db push --linked --dry-run:
  connected; would apply exactly 20260729125000 and 20260729130000
supabase db push --linked --yes:
  both migrations applied successfully
final dry-run:
  Remote database is up to date

live database:
  live default prompts = 1
  prompt name = Qimati ivory marble — product fidelity
  prompt body = exact business-approved text; no resolution/aspect-ratio text
  category defaults = AK/BK/CB/ER/NK/NP/RS all 0 g
  prompt.default_seeded and catalog.shipping_weight_confirmed events present
```

Step 0 used `POST https://openrouter.ai/api/v1/images`, model
`openai/gpt-image-2`, `quality: "high"`, `size: "2048x2048"`, one real 2000×2000
JPEG input and the sole live default prompt:

```text
HTTP status                 200
provider                    OpenAI
editing with input          YES — the returned marble scene retained the specific necklace
requested dimensions        2048 × 2048
actual dimensions           2048 × 2048 PNG
round-trip latency          222.242 s
response cost               $0.44116
cost source                 response usage.cost (exposed directly; not derived)
input references supported  0–16 according to live model/endpoint metadata
input references exercised  1 (multi-reference composition was not separately tested)
```

Saved proof (Git-ignored, retained locally):

```text
.artifacts/phase3b-step0/source-neck-227526.jpg   2000×2000, 54,596 bytes
.artifacts/phase3b-step0/gpt-image-2-result.png  2048×2048, 4,531,577 bytes
.artifacts/phase3b-step0/evidence.json            request/response metadata and usage
```

Quality and migration evidence:

```text
Test Files  13 passed (13)
Tests       172 passed (172)
typecheck:  passed
lint:       passed
build:      passed
db lint:    No schema errors found
git diff --check: passed
```

**Not finished / known broken:**

- The Phase 3B enhancement worker is intentionally **not started**. The session stopped at
  the requested architecture gate.
- A second input reference was not sent because Step 0 was constrained to one real photo
  and one image-generation call. OpenRouter advertises up to 16 for this endpoint.
- OpenRouter does not advertise a mask parameter for this route; no mask workaround was
  designed.

**Surprises:**

- The previous `$0.07–$0.20` estimate in `CLAUDE.md` was wrong for this real high-quality
  call: it cost $0.44116, exposed directly in the response.
- One edit took 222.242 seconds. That is a real worker time-budget constraint, not a
  sub-second API call.
- Although the endpoint metadata advertises aspect ratio rather than a native pixel-size
  control, OpenRouter accepted the `2048x2048` size shorthand and returned exactly that.

**Next session should start with:** review this Step 0 cost/latency/result and, only after
business approval, design the Phase 3B worker around the existing UUID ownership token.

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
   relaxed `> 0` → `>= 0` so both states stay expressible. **Business confirmation:
   Qimati uses fixed shipping rates, so 0 g is the correct settled value and is not a
   cutover blocker.**
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
