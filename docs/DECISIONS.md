# Decisions

Settled architectural choices and the reasoning behind them. **Read before changing anything structural.** If you believe a decision is wrong, say so and ask — do not silently reverse it.

Append new decisions as you make them. Format: what was decided, why, and what was rejected.

---

### D1 — The operator picks the category; nothing guesses it

Automatic classification was considered and rejected. An anklet and a chain bracelet are the same object at different lengths and cannot be told apart from a photograph. Folder-per-category and printed QR cards were also rejected — the first invites misfiling, the second adds work at the shoot.

Category is a single click from someone already looking at the image. Because each category owns its own SKU sequence, a misclassification produces a wrong SKU *and* corrupts the sequence for everything after it, so the cost of a wrong guess is high.

**Consequence:** the Drive folder needs no structure at all. One flat folder.

---

### D2 — SKU numbers come from an atomic counter, never from Shopify

`SELECT max(sku)` then `+1` is exactly what produced the live duplicate `RS221` on two different products. Shopify enforces no SKU uniqueness and will accept a collision silently. Drafts, deletions and in-flight writes all make a "current max" query lie.

**Implementation:** `sku_counters` table, one row per prefix, incremented with a single `UPDATE … RETURNING` inside the publish transaction. The console displays a *predicted* SKU; the authoritative one is allocated server-side at publish.

**Seed from the true max per prefix, not a row count** — the existing sequences have gaps (`RS218`, `RS220`, `RS222` are missing).

#### What D2 forbids, precisely — read this before "fixing" `seed:counters`

D2 forbids reading Shopify's max **at publish time**. It does not forbid reading Shopify at all.

`npm run seed:counters` (Phase 2) reads every product from the Admin API, takes the max number
per prefix, and raises `sku_counters.last_number` to it. That is a **deliberate one-time
seeding operation, run with the store quiet**, and it is the only way to establish the starting
point for a counter that has to continue a sequence a human maintained by hand for 1,600
products. Without it the first publish reissues `NK001`.

The two are different in every way that matters:

|  | `seed:counters` | the thing D2 forbids |
|---|---|---|
| when | once, at setup and at cutover | on every publish |
| store activity | quiet, by arrangement | concurrent publishes in flight |
| effect of a stale read | none — it only ever raises | a duplicate SKU on a live product |

The safety properties are enforced, not merely intended: the write goes through
`public.raise_sku_counter(prefix, to)`, a single `UPDATE … SET last_number =
greatest(last_number, p_to)`. It is **monotone** — it can never lower a counter — and therefore
idempotent and safe to re-run, including against a store that has been published to since.
`--dry-run` changes nothing. Prefixes found in Shopify but absent from `categories` are
reported and **not** created (an invented prefix starts a sequence nobody can reconcile).

**So:** if a future session finds `seed:counters` and thinks it contradicts D2 — it does not.
Do not delete it. Publish still allocates from the counter and never from Shopify.

---

### D3 — The database is not optional

Considered dropping it to simplify. Rejected: it holds the SKU counters (D2), the work queue so a half-built listing survives a closed laptop, the colour vocabulary, prompt and version history, and the audit trail from product back to source photograph. Errors are perhaps a tenth of what it stores.

At ~300 products/month the row data is a few MB a year and runs on Supabase's free tier indefinitely.

---

### D4 — Cloudflare R2 for images, Supabase for data only

Supabase Storage free tier is 1 GB with 5 GB egress; R2 is 10 GB with **free unlimited egress**. On Supabase the 1 GB ceiling breaks in week one without a retention job. R2 gives roughly five weeks of slack even with no retention at all, which matters for a system nobody watches closely at first.

Bucket is **private**; access via presigned URLs only, because images sit in the bucket before they're published — including rejected versions and unreleased pieces.

**The bucket is named `loupe-image` — singular.** Confirmed 2026-07-28 against the Cloudflare
dashboard: name `loupe-image`, location **APAC**, created 28 Jul. Earlier revisions of this
decision and of CLAUDE.md said `loupe-images` (plural); they were wrong, and `.env` was right.
This also closes the Phase 0 note about an `ENAM`-located bucket needing to be recreated —
the surviving bucket is APAC, which is what Jaipur operators and a Mumbai Vercel region want.

**Superseded:** a Supabase Storage bucket named `images` was created first and abandoned. Delete it.

---

### D5 — `gpt-image-2` **via OpenRouter**, no dated pin, at 2048×2048

*Revised 2026-07-28 (Phase 2). The original text specified a direct OpenAI call pinned to a
dated snapshot. Both halves of that changed; the reasoning for each is below.*

**Model family: still `gpt-image-2`.** Unchanged, and for the original reason — the existing
prompt was developed in ChatGPT, so staying in the same family means enhanced images keep
looking like the ones the team already approves. Switching provider outright would mean
re-tuning the prompt and a visible seam in the catalogue between old and new products.

**Route: OpenRouter, not the OpenAI API directly.** `.env` carries `OPENROUTER_API_KEY` and
`OPENROUTER_OPENAI_IMAGE_MODEL=openai/gpt-image-2`, and deliberately no `OPENAI_API_KEY`. One
key and one billing account cover both `openai/gpt-image-2` and the Gemini model already being
compared against it, so a swap — or a fallback when one provider is down — is a config change
rather than a second SDK, a second key and a second invoice. `GEMINI_API_KEY` /
`GEMINI_IMAGE_MODEL` stay as the direct-to-Google escape hatch if OpenRouter itself is
unavailable.

**No dated pin.** The original decision pinned `gpt-image-2-2026-04-21` to stop the catalogue's
look drifting as the underlying model moved. Rejected, for two reasons:

1. A pin is not available to pin. Which snapshots OpenRouter exposes behind
   `openai/gpt-image-2`, and for how long, is not something this project controls. A pin that
   silently stops resolving is worse than no pin: it fails at 3 a.m. in a worker, not at
   review time.
2. **The real mitigation is the record, not the pin.** `image_versions` stores `model` and
   `prompt_text` on **every single row**. Any published image can be traced to the exact model
   string and the exact prompt text that produced it. That makes drift *diagnosable* — "these
   forty products look different, and here is the model string they were generated under" —
   which is what is actually needed. A pin only promises drift won't happen, and quietly
   breaks that promise the moment anyone changes a config value.

So the enhancement worker **must** write `model` and `prompt_text` on every `image_versions`
row, with the resolved model string exactly as sent, never a friendly alias. That is now a
correctness requirement of D5 and not an audit nicety.

2048×2048 is Shopify's own recommendation for square product images.

**Known trade-off (unchanged):** a generative model redraws the whole frame, so fine chain
links and stone facets are reinterpreted rather than photographed. Mask-and-composite (keeping
the photographer's original pixels for the product and replacing only the background) is
sharper and cheaper, and remains the fallback if zoom quality proves unacceptable. Keep the
enhancer behind one interface so this can be swapped without touching anything else.

---

### D6 — The description lives in the theme, not on the product

Only the material varies across the six description bullets. Storing the material in a **metafield** and rendering the bullets in the theme means a wording change is one edit instead of a bulk update across 1,600+ products — and it stops reproducing the WhatsApp CSS classes currently embedded in the live catalogue.

---

### D7 — The console is the approval step; publish goes straight live

No Shopify draft stage. The operator sees the image, the resolved SKU and the price before pressing Publish, which is the approval. A "Save as draft" button remains as an escape hatch for uncertain pieces.

---

### D8 — Duplicate detection uses perceptual hashing, not a model

A learned similarity checker was rejected as insufficiently trustworthy. A perceptual hash is a fixed algorithm — the same image always produces the same fingerprint — and it only ever raises a *warning* before publish, never blocks or decides.

---

### D9 — Monochrome UI with exactly one accent colour

The interface is black / white / grey because the content is gold and silver jewellery: a neutral UI makes the product photographs the only colour on screen.

**One** accent (amber) marks "needs attention", and nothing else. A second accent would erode the first. Density is deliberately higher than the visual reference the design came from — the reference is a portfolio piece showing eight data points; this tool shows twenty-plus thumbnails and is driven by keyboard.

---

### D10 — Closed vocabularies are Postgres enums, not text + CHECK

`intake_status`, `error_class`, `draft_status`, `image_kind` and `app_role` are all fully
enumerated in the phase spec, so they are enum types. They generate real TypeScript union
types from `supabase gen types`, and widening one later is a single `ALTER TYPE … ADD VALUE`.

**Rejected:** `text` + `CHECK`. Easier to narrow, but it produces `string` in TypeScript,
which defeats the "no `any` in domain logic" rule at exactly the points where a typo in a
status string would be most expensive.

---

### D11 — RLS is enabled on every table with zero policies

Not "RLS off because everything is server-side anyway". Every table has row level security
enabled and no policies at all, which in Postgres is a default deny: `anon` and
`authenticated` can read and write nothing. `service_role` bypasses RLS, so the server-only
client keeps full access.

That makes hard rule 7 structural rather than a habit — the browser client is harmless
because the database refuses it, not because we remembered to be careful. Table privileges
are additionally revoked so that a future migration adding one narrow policy cannot
accidentally expose a whole table.

`tests/rls.test.ts` asserts it, table by table, using the real publishable key.

**Consequence:** any screen that later needs direct browser reads must add a policy in its
own phase's migration and justify it. That is deliberate friction.

---

### D12 — Migrations are applied by a small script, not the Supabase CLI

`npm run db:push` reads `supabase/migrations/*.sql` in filename order and applies each in its
own transaction, recording versions in `supabase_migrations.schema_migrations` — the same
table the CLI uses, so the two stay interchangeable.

**Rejected:** the Supabase CLI. It is not on the path, installing it pulls in a Docker-based
local stack, and `supabase link` wants a personal access token this project does not have.
For fourteen files that is more machinery than the problem deserves.

**Note:** `db:push` needs `SUPABASE_DB_PASSWORD`, which was stale during Phase 1 — see the
Phase 1 entry in PROGRESS.md. The Phase 1 migrations were applied through the Supabase
Management API instead. `db:push` itself is therefore written but not yet exercised.

---

### D13 — Domain data is seeded by a migration; people are seeded by a script

Categories, SKU counters and materials are domain facts, identical in every environment, and
live in `supabase/migrations/20260728121100_seed_domain_data.sql`.

Who may sign in is not a domain fact. `app_users` is seeded by `npm run seed:admin`, which
reads `SEED_ADMIN_EMAIL`. Baking a person's address into a migration would grant them access
to staging and production the moment those exist.

Both are idempotent.

---

### D14 — `reserved_sku` and `reserved_handle` are UNIQUE in the database

Beyond the atomic counter. The counter prevents two allocations returning the same number;
these indexes prevent a wrong number ever being stored, whatever produced it — a manual
correction, a bad backfill, a bug in a future phase.

`RS221` exists on two live products. Had this index existed, the second write would have
failed loudly instead of succeeding quietly. The unique `reserved_handle` is what makes
retry-by-handle (hard rule 2) safe.

---

### D15 — Two service-role-only introspection functions exist for the tests

`_loupe_function_source(name)` and `_loupe_schema_report()` let the test suite assert against
the **deployed** database rather than the migration files on disk. Those drift the moment
somebody edits something in the Supabase SQL editor, and the drift that matters most —
`next_sku` "simplified" into a SELECT then an UPDATE, an index dropped, RLS switched off to
debug something — is invisible in the repository.

They grant nothing: `service_role` can already read `pg_catalog`. `anon` and `authenticated`
are revoked.

---

### D16 — The concurrency test is proved against a known-broken control

A test that passes is only evidence if it would fail on a broken implementation.
`tests/fixtures/naive-counter.sql` is the SELECT-then-UPDATE counter that produced `RS221`,
and `npm run verify:sku-control` runs the identical 100-way load against both.

Measured: the shipped function returned 100 distinct numbers; the naive one returned **13**
distinct numbers for 100 products. Without the control, "100 distinct integers" is just a
number.

The fixture is never left loaded — `tests/schema.test.ts` fails if it is present.

---

### D17 — Colour names are normalised by a database trigger, not by the application

CLAUDE.md requires trim / collapse-spaces / Title Case on save. That runs in a `BEFORE INSERT
OR UPDATE` trigger calling `normalise_colour_name()`, so `UNIQUE (name)` genuinely means
"unique after normalisation".

Enforcing it in application code would hold only for writes that went through the
application. A backfill, a fix applied in the SQL editor, or a second phase's worker would
each reintroduce `rose gold`.

---

### D18 — The publish transaction lives in Postgres functions, not in TypeScript

"Reserve SKU + handle inside one transaction" is not achievable over PostgREST: every
supabase-js call is its own transaction. A crash between `next_sku()` returning 225 and
the UPDATE that stores `RS225` would burn the number *and* leave the draft unreserved,
and the next publish would produce a product whose SKU is one ahead of the sequence with
no record of why.

So `reserve_draft_identity()`, `mark_draft_published()` and `mark_draft_failed()` are
plpgsql. Inside a function it is one transaction: either the counter moved and the draft
carries the identity, or neither happened. Each also writes its own `events` row, so no
caller can move a draft without leaving a trace.

**Rejected:** doing it in TypeScript with a compensating "give the number back" path.
There is no correct way to give a number back — another publish may already have taken
the next one, and lowering a counter is the thing that produces a second `RS221`.

**Consequence:** the same invariants are checked twice — in
`src/lib/publish/validate.ts` for the operator, with all reasons at once and readable
wording, and again as `raise` statements in SQL for anything that reaches the database
another way. That is deliberate, not duplication to be tidied away.

---

### D19 — Publish also blocks on an unknown weight and a missing material

Hard rule 8 names price and stock. Two more were added, and both for the same reason:
the alternative is not "publish anyway", it is "publish something silently wrong".

**Weight.** Every variant in the live store weighs 0, which is exactly why weight-based
shipping does not work there. Defaulting to 0 would reproduce that bug in the tool built
to replace the process that caused it. `categories.default_weight_g` is NULL for every
category — deliberately, since Phase 1 — so this blocks *everything* until real
per-category grams are collected from the business. That is the point: the block is
visible, a 0 g product is not.

**Material.** The six description bullets render from the material metafield (D6), so a
product without one publishes with no description at all. Material is a three-way choice
the operator is already making.

Both surface as ordinary `PublishBlock`s alongside price and stock, so hard rule 8's
"never block silently" still holds.

---

### D20 — The SKU number is zero-padded to three digits; the title number is not

`AK011`, `RS221`, `NK970` in the SKU. `Rings 221`, `Anklets 87 (Single Piece)` in the
title. Numbers past 999 simply get wider, which the
`reserved_sku` CHECK (`^[A-Z]{2,4}[0-9]{3,}$`) allows.

The SKU side is confirmed against the live store. **The title side below 100 is not** —
no live product with a number under 100 was inspected, so whether the live store writes
"Anklets 87" or "Anklets 087" is an assumption. Unpadded was chosen because the live
handle `rings-224set-of-10-different-rings-for-750-copy` shows an unpadded number in a
title. **Confirm at cutover**, before `seed:counters` runs against the live store — for
the six existing prefixes every next number is ≥ 88, so the two renderings only diverge
for a brand-new prefix such as `NP`.

---

### D21 — The material metafield is `custom.material`

`namespace: "custom"`, `key: "material"`, `type: "single_line_text_field"`, so a theme
reads it as `product.metafields.custom.material`. `custom` is Shopify's own namespace
for admin-defined custom data and is what a hand-edited theme would most naturally use.

**Unverified against the live theme.** The Phase 2 test store has no theme reading it.
If the live theme uses a different namespace the bullets render empty, which is visible
immediately on one product — so this is cheap to check and cheap to change. Do it before
cutover, on one product, and look at the storefront.

---

### D22 — `src/lib/shopify/*` does not carry `import 'server-only'`

`src/lib/env.ts` and `src/lib/supabase/server.ts` do. The Shopify modules cannot: they
are imported by `scripts/` and by vitest, both of which run in plain Node where the
`server-only` shim throws. Phase 1 sidestepped this by having scripts declare their own
`required()`; that does not work for a module the application and the scripts genuinely
share.

Hard rule 7 is kept structural instead of by convention:

1. Next.js never inlines a non-`NEXT_PUBLIC_` variable into a client bundle — in a
   client component `process.env.SHOPIFY_CLIENT_SECRET` is `undefined`, not the value.
2. `npm run verify:isolation` now scans the built client assets for
   `SHOPIFY_CLIENT_SECRET` as well as the Supabase service-role key, against the same
   control that proves the scan can see values which really do ship.

**Rejected:** aliasing `server-only` to a stub in vitest *and* registering a loader hook
for tsx. Two pieces of test-harness machinery to keep one import line, and the machinery
would itself become the thing that silently stops working.

---

### D23 — `categories.shopify_tag` is nullable, and NULL blocks publish

Phase 2 added Nose Pins (`NP`, `Nose Pin {n}`). The prefix and title pattern are
confirmed; the tag is not — nobody has read one off a live Nose Pin.

Collections are tag-driven, so an invented tag (`nose-pin`? `Nose Pins`? `nosepin`?)
would publish the product **successfully** and drop it out of its collection with no
error anywhere. That is this project's worst failure mode, because it looks like success.

So `NOT NULL` was dropped from `shopify_tag`, NULL means "not confirmed", and
`reserve_draft_identity()` raises rather than reserving. The existing
`CHECK (length(btrim(shopify_tag)) > 0)` still rejects `''` — a CHECK only fails on
FALSE, and it evaluates to NULL here. So NULL is "unknown" and empty is still invalid.

Filling the tag in makes the category work with no code change and no migration.

---

### D24 — The Shopify API version is pinned in code, overridable by env

`DEFAULT_SHOPIFY_API_VERSION = '2026-07'` in `src/lib/shopify/config.ts`, overridable
with `SHOPIFY_API_VERSION`. `.env` does not set it.

Shopify supports each version for twelve months and changes input types between them —
`ProductSetInput` in particular. Reading the version from an unset environment variable
and falling back to "latest" would mean the shape of our writes could change without a
commit. Bumping it is a deliberate act, and `npm run shopify:introspect` prints the input
types Loupe depends on so the bump can be checked in a few seconds.
