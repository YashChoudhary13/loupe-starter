# Phase 4 — the authenticated Listing Console

Recorded from the session prompt of 2026-07-30 so the success criteria survive the
session. CLAUDE.md: *never mark a phase complete until every success criterion in its
prompt file has been met **and demonstrated**.*

**In scope:** Google sign-in, `app_users` authorisation, the protected console, the
enhanced-image queue, grouping, version selection and ordering, the product editor and
identity preview, Save Draft, publish through the existing path, Shopify product images
and alt text, best-effort Drive `/Processed` housekeeping, keyboard-first operation,
operator-readable errors, audit events, and real verification against the **test** store.

**Out of scope — do not build ahead:** description-model comparison, cost optimisation,
prompt-management UI, redo generation, version history beyond choosing an existing
version, duplicate detection, perceptual-hash warnings, the tracking dashboard, daily
Shopify reconciliation, live-store cutover, category auto-classification, price
prediction, and an admin colour-merge UI unless it is already inseparable from colour
entry. No third model call. **No model call from the console at all.**

**Model/provider selection is out of scope (D43).** `DESCRIBE_MODEL`,
`DESCRIBE_REASONING_EFFORT`, `IMAGE_MODEL`, `IMAGE_SIZE` and `IMAGE_QUALITY` must not
change, the Phase 3C prompt architecture and presentation classes must not change, and
the paid Phase 3C acceptance set must not be re-run.

**Test store only.** `qimti.myshopify.com`. Nothing points at the live store or
`qimati.in`; live cutover is Phase 7.

---

## Entry state

Phases 1, 2, 3A and 3B are complete. Phase 3C is implemented, deployed and visually
verified but deliberately **not complete** — criterion 17 (description cost `< $0.006`)
failed and has been deferred by D43. Phase 4 proceeds regardless. Do not mark Phase 3C
complete and do not alter its historical evidence.

---

## 1. Authentication

Google sign-in. Authorisation is **exact membership of `app_users`**, not email domain.
`ALLOWED_EMAIL_DOMAIN` stays unset and `SEED_ADMIN_EMAIL` stays a gmail.com address —
that is by design (CLAUDE.md), not a bug.

Required behaviour:

- an unauthenticated visitor is redirected to the sign-in screen;
- a Google-authenticated user whose email is an **active** `app_users` row may enter;
- a Google-authenticated user who is not in `app_users` gets a clear access-denied
  screen and **no application data**;
- archived / `active = false` users must not gain access;
- sign-out clears the session;
- the session survives a normal page refresh;
- protected actions re-verify authorisation **on the server**, every time;
- never trust a client-supplied role or email;
- never expose the service-role key.

The authenticated identity establishes *who the user is*, nothing more. Application data
is still read and written by server-side code holding the service-role key. **Do not add
browser-readable RLS policies to simplify the UI** — the default-deny model (D11) stays
intact.

**Audit identity.** Where a human performs an action, the event actor is their authorised
application-user identity, not a browser-supplied display name.

## 2. Console routes

```
/login
/console
/console/drafts/[draftId]
```

The primary console route holds the queue grid and the selected-product editor side by
side, with a persistent publish action and no navigation into a separate form for the
common case. The operator processes many products without changing pages.

## 3. Server-only data access

Every sensitive read and write happens on the server: Supabase service-role access, R2
signing, Shopify, Google Drive, draft creation, draft mutation, SKU prediction and
publishing. The browser receives only what the console renders.

R2 stays private. Display uses **short-lived presigned URLs**. No permanent public R2 URL
appears in page source, a database row, or client JavaScript. The queue grid uses
thumbnails; full images are fetched only where the operator reviews one closely.

## 4. Queue read model

At minimum: enhanced-and-ungrouped photographs, saved product drafts, and photographs
already assigned to the open draft. This is not the Phase 6 tracking page — failed,
stalled and retrying infrastructure records may be summarised or linked, not detailed.

Each tile shows a thumbnail, filename where useful, selected state, image/group count
where relevant, the current draft or category label where relevant, and an attention
state **only** when a human is needed. Design system: photograph is the only major
colour, monochrome chrome, amber only for attention, black for active, pill geometry,
dense layout, usable at twenty-plus visible thumbnails.

## 5. Grouping

- one photograph is a valid product; several may form one;
- grouping persists across refresh;
- an intake photograph **cannot silently belong to two drafts**;
- concurrent grouping attempts are race-safe — exactly one wins;
- a grouped photograph leaves the ungrouped queue;
- removing a photograph from an **unpublished** draft returns it to the queue;
- a published draft cannot be casually dismantled;
- every grouping and ungrouping transition writes an event.

The database decides which photograph belongs to which draft. No second source of truth
in browser state.

## 6. Image-version selection and order

For Phase 4 the operator chooses among versions that already exist (original, generated).

- default to the selected generated version where one exists;
- allow choosing the original;
- show enough to tell original from generated;
- the choice is stored in `product_draft_images`;
- historical `image_versions` rows are **not** mutated because one draft chose a version;
- the same selected version is what Shopify receives;
- selection and order survive a refresh;
- every image in a product has a deterministic order, and reordering is supported;
- **Shopify image order matches the operator's draft order.**

## 7. Product editor

Human judgement: **category** and **price**. Controlled: material, stock, weight
resolution, colours, optional title suffix. Derived: predicted SKU, title, handle,
Shopify tag, product type, material metafield, variant structure, selected image count.

- **Category** — the operator chooses; the AI never does (D1). A category with no
  confirmed `shopify_tag` is visibly unavailable for publishing, or produces the existing
  explicit validation error (D23). Never invent a prefix, title pattern or tag.
- **Material** — normally `304`, `316L`, or `Brass`; a one-off custom material is allowed
  and stored on the draft without changing the global suggestions (D50).
- **Description** — clean six-bullet default derived from material, with a rare plain-text
  per-product override and reset-to-default action. Raw HTML is never accepted (D50).
- **Price** — integer paise, parsed from a rupee string **without floating point**.
  Reject empty, zero, negative, malformed and more than two decimal places.
- **Stock** — category default, explicit override allowed; zero blocks unless the
  existing explicit override is ticked.
- **Weight** — `NULL` = unknown = blocked, `0` = deliberate zero = valid. `??`, never
  `||` (D19).
- **Colours** — zero or more, normalised by the existing database trigger (D17), ranked
  by per-category usage where the schema supports it. Colours create Shopify variants
  that share the parent SKU.
- **Title suffix** — optional free text; affects title and handle preview; never affects
  the SKU prefix.

## 8. Sticky defaults

Carry forward **category, material and a sensible stock default**. Never carry price,
colours, title suffix or selected images. Sticky defaults may be browser-local; they must
not corrupt the database, and a saved draft's values always outrank them.

## 9. Identity preview

A high-emphasis read-only `SKU · title · handle` preview in the black feature-card
treatment. Displaying it moves no counter. Saving a draft moves no counter. Only the
existing server-side reservation path allocates the authoritative SKU. The TypeScript
preview must agree with the deployed database reservation logic **for every configured
category** — test that parity directly. Label the SKU predicted until publish reserves
it, then show the real reserved identity.

**Frozen identity (D27).** Once reserved: retries reuse the same SKU and handle, category
may not change, title suffix may still be corrected, the UI explains why category is
locked, and correcting the category means a new draft. Never allocate a second SKU to fix
this.

## 10. Save as draft

Persists grouping, selected versions, order and product fields. Reserves no SKU. Does not
publish. Does not move Drive files. Writes an event. The operator can close the browser
and resume; no half-built listing depends on local component state.

## 11. Validation

Reuse the existing server-side validation (`src/lib/publish/validate.ts`). No weaker
UI-only ruleset. Show **all** problems at once, each naming its field and how to fix it.
Preserve the existing blocks — missing/zero price, zero stock without override, missing
material, unknown weight, unconfirmed category tag — and add "no selected product image".
A blocked publish reserves no SKU, demonstrated against the real database. Client-side
validation may improve responsiveness; the server and database stay authoritative.

## 12. Publishing

Use the existing `publishProduct()` and reservation architecture. No parallel publish
path. Publishing stays atomic around reservation, idempotent by handle, safe under retry,
protected by server authorisation and fully audited.

1. verify the authenticated operator;
2. load the authoritative draft from the database;
3. validate the complete draft;
4. reserve or reuse the identity;
5. publish/update the product in the **test** store;
6. publish selected images in draft order;
7. write image alt text;
8. read the Shopify result back;
9. mark the draft and intake rows published;
10. write audit events;
11. attempt Drive housekeeping **separately**.

Never trust product fields posted from the browser without loading and validating the
stored draft.

## 13. Shopify product images

Inspect the pinned `2026-07` schema before choosing the mutation shape; do not assume an
old media API. Selected versions only, draft order preserved, retry creates no duplicate
media, the reserved handle stays the product identity, image publishing is recoverable
after an interruption, the final product holds the expected number of images, and order is
verified by read-back where the API exposes it. A failure in image publishing must never
produce a second Shopify product — a retry completes or repairs the same one.

## 14. Image alt text

`intake_files.product_description` was deliberately cached for this. For each selected
source image, write **its own** stored factual description as that image's alt text. Do
not generate a new description, do not use the presentation class, do not fall back to a
filename where a valid cached description exists, and **make no model call**. Where the
description is missing because the pipeline degraded, use a deterministic non-invented
fallback, record it, and fabricate no jewellery detail. Verify alt text by reading it back
from Shopify.

## 15. Post-publish Drive housekeeping

After a successful publish, attempt to move each source photograph from Raw to
`/Processed`. Housekeeping only; never a state transition (hard rule 3). Ordering:
Shopify publish succeeds → database marked published → *then* attempt the move.

If the move fails: the product stays published, intake rows stay published, no Shopify
rollback, a readable event is recorded, the issue is surfaced for later tracking, no
second product is created, and intake is never reverted to `enhanced` or `grouped`. The
move is idempotent — a retry must not fail because the file is already in `/Processed`.
Drive-folder presence never decides processing state.

## 16. Keyboard-first operation

Usable without a mouse. Selecting a queue tile focuses the price input; category is
keyboard reachable; every control has a visible focus ring; `Enter` publishes only when
appropriate and never while a multiline or choice interaction is open; after success focus
advances to the next ungrouped item; `Escape` (or another documented key) cancels an
in-progress selection without data loss; the sticky Publish action never scrolls out of
view. No global shortcut fires while the operator types into an unrelated field. Test the
actual keyboard path.

## 17. Error handling

Written for the operator: what happened, whether data was saved, what is safe next, and
whether a retry reuses the same product identity. Raw API/database detail lives behind a
**Details** expander. `HTTP 500` / `GraphQL error` / `UNSUPPORTED_MEDIA_TYPE` alone is
never acceptable. No secrets, tokens, signed URLs or private provider payloads in the
operator-facing message.

## 18. Design

`docs/DESIGN.md` and the HTML mockups. Background `#EDEDED`, white cards, black active
states, amber only for attention, green only for timeline success, photograph as the only
major colour, Inter, pill-shaped interactive controls, dense layout, 24px card radii, 16px
thumbnail radii, fully rounded interactive elements, visible 2px inset focus rings, black
identity feature card, sticky publish. shadcn/ui + Tailwind, themed to the tokens — never
the default shadcn look. No gradients, colourful status systems or decorative charts.

## 19. Concurrency and race safety

- **Grouping race** — two concurrent requests grouping the same intake file into
  different drafts: exactly one succeeds; the file never belongs to both.
- **Save race** — two rapid saves lose no image assignment and silently revert no newer
  data. Use an explicit concurrency strategy.
- **Publish double-submit** — two concurrent publishes of one draft yield one reserved
  identity, one Shopify product, no duplicate images, one final published state. Disable
  duplicate client submission for usability, but rely on server/database idempotency for
  correctness.

---

## Success criteria

Phase 4 is not complete until **every** item below is demonstrated with evidence.

1. **Authorised sign-in** — a real authorised Gmail account signs in; session survives
   refresh; sign-out works; the actor is identified correctly.
2. **Unauthorised sign-in denied** — a valid Google account absent from `app_users`
   cannot access console data, cannot invoke protected actions, and sees a clear
   access-denied message. Do **not** add that account to `app_users` to simplify the test.
3. **Default-deny boundary intact** — the browser publishable key cannot read application
   tables or create/update drafts; all access is through protected server code; the
   service-role key and other secrets are absent from client assets.
4. **Queue renders real enhanced images** — thumbnails from private R2 through short-lived
   URLs; an expired URL stops working; full images are not loaded per tile; twenty-plus
   tiles remain usable at the designed density.
5. **Grouping persists and is race-safe** — one image into a draft; several into another;
   survives refresh; concurrent attempts cannot assign one intake row to two drafts;
   ungrouping returns the image to the queue; events written.
6. **Version choice and order persist** — a generated version selected; an original
   selected for another source; at least three images reordered; reload preserves both;
   Shopify receives that order.
7. **Draft editing and sticky defaults** — category and material carry to the next new
   draft; price does not; saved values outrank defaults; colours normalise; category-ranked
   colour suggestions work where data exists; paise conversion is exact, including `₹75`,
   `₹75.50` and `₹750`.
8. **Preview burns no SKU** — viewing the preview moves no counter; changing category
   updates the predicted identity; changing suffix updates title and handle; Save Draft
   moves no counter; the TypeScript preview agrees with the deployed database reservation
   logic for **every** configured category.
9. **Validation blocks safely** — a draft with several invalid fields shows every reason at
   once, reserves no SKU, creates no Shopify product, and can be corrected without
   rebuilding the draft.
10. **End-to-end publish** — a real grouped product published to the test store and read
    back: title, handle, SKU, tag, `product_type = Jewellery`, price, stock, 0 g weight,
    `custom.material`, clean `descriptionHtml`, variants, selected image count, image order,
    image alt text, active status, exactly one product. Paste the Shopify product ID.
11. **Idempotent retry** — force an interruption after Shopify has accepted the product but
    before Loupe records success, then retry: same SKU, same handle, same Shopify product
    ID, exactly one product, no duplicated media, final status published.
12. **Double-submit safety** — two concurrent publishes of one draft: one identity, one
    product, no duplicated media, one final state.
13. **Image alt text** — Shopify read-back shows each selected image carrying the
    corresponding cached description; no extra describe call occurred; the
    missing-description fallback is deterministic and audited.
14. **Drive `/Processed` housekeeping** — source files move after a successful publish; the
    published database state exists before the move; repeating it is safe; a forced move
    failure does not undo publication and produces an operator-readable event.
15. **Browser-resume** — an incomplete saved draft survives a reload with grouping, fields,
    version selections and order intact, no SKU reserved, and the operator can continue.
16. **Keyboard workflow** — select tile → choose category → type price → `Enter` → publish →
    advance, with visible focus rings and no accidental publication while editing another
    control.
17. **Visual acceptance** — screenshots at normal desktop width, narrower laptop width, a
    queue with twenty-plus items, an active draft with several images, a validation-error
    state and a successful-publish state, compared against the mockup and DESIGN.md. Any
    deliberate deviation documented with its reason.
18. **Cleanup and production restoration** — temporary Shopify products, Drive fixtures, R2
    objects and database fixtures removed; local evidence preserved; production cron
    schedules still active; empty ticks return 200; no live-store configuration changed.

### Quality gates

```
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:isolation
supabase db push --linked --dry-run
supabase db lint --linked --level warning
```

Plus authentication integration tests, the grouping concurrency test, preview/database
identity parity tests, the double-publish test, real test-store publish verification,
Shopify media read-back, alt-text read-back, the Drive housekeeping failure test, the
browser keyboard test and visual screenshot verification. **The final publish criteria may
not rest on mocks.**

### Evidence

Git-ignored, under `.artifacts/phase4-acceptance/`: screenshots, test output, Shopify
read-backs, the product ID, image-order and alt-text evidence, grouping-race and
double-submit evidence, Drive move and forced-failure evidence, the cleanup receipt and
the final cron state. **No secrets, access tokens or unredacted signed URLs in evidence
files.**
