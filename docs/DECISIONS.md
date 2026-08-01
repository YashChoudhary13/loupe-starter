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

### D5 — `gpt-image-2` **via OpenRouter**, no dated pin, with explicit image controls

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

Every call sends size and quality explicitly. The production defaults are configuration,
not worker constants: `IMAGE_SIZE=1280x1280`, `IMAGE_QUALITY=medium`, and
`MAX_COST_USD_PER_IMAGE=0.20`. The input copy is downscaled to a 1024 px long edge before
upload because input pixels are billed while output rendering is controlled separately.
Actual response cost is persisted; it is never reconstructed from a price table.

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

> **Superseded in part by D60 (2026-07-31).** "No Shopify draft stage" is no longer true:
> Save Draft now creates a real Shopify product with status DRAFT. The rest of D7 stands —
> Publish is still the approval, and it still goes straight live.

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

### D19 — Fixed-rate shipping makes 0 g correct; **NULL and 0 remain different**

*Revised 2026-07-29. The original blocked on any weight that was not a positive number.
The first revision allowed a deliberate 0 but treated it as a temporary test-store value.
The business has now confirmed Qimati uses fixed shipping rates: weight does not participate
in shipping, so 0 g is the correct final value. The unknown-value guard remains.*

Hard rule 8 names price and stock. Two more are blocked, both for the same reason: the
alternative is not "publish anyway", it is "publish something silently wrong".

**Material.** The six description bullets render from the material metafield (D6), so a
product without one publishes with no description at all. Material is a three-way choice
the operator is already making.

**Weight — and the distinction that carries it:**

| value | meaning | publish |
|---|---|---|
| `NULL` | nobody has said | **BLOCKED** |
| `0` | someone said zero | proceeds, writes 0 g |

Every `categories.default_weight_g` is **0**. That is the correct Qimati catalogue value,
not a placeholder: fixed shipping rates are selected independently of variant weight.
There is no per-category weight collection task and no weight-related cutover blocker.

The mechanics that keep the distinction real, all of which are load-bearing:

- The CHECKs were relaxed from `> 0` to `>= 0`, **not dropped**. A negative weight is
  still nonsense, and NULL must stay expressible or the unknown state disappears.
- `resolveWeightG` uses `??`, never `||`. With `||` a draft deliberately set to 0 g
  would silently publish at the category's weight instead — the operator's decision
  discarded for being falsy.
- `tests/schema.test.ts` asserts the column can still hold NULL. If a future migration
  adds `NOT NULL DEFAULT 0`, the unknown state vanishes and the guard in
  `validate.ts` silently stops being reachable — which is worse than deleting it,
  because the code would still look like it was protecting something.

**Rejected:** deleting the weight block entirely. NULL still means the configuration has
no answer, which is different from the confirmed answer 0. Silently coercing unknown to
zero would erase that distinction even though Qimati's current settled default is zero.

---

### D20 — SKU **and** title numbers are zero-padded to a minimum of three digits

*Revised 2026-07-29. The original padded the SKU and left the title unpadded. Confirmed
against live data — the title is padded too.*

```
   4 → NP004 · "Nose Pin 004"        87 → AK087 · "Anklets 087 (Single Piece)"
 221 → RS221 · "Rings 221"          970 → NK970 · "Necklace 970"
```

`%03d` — a **minimum** of three digits, never a fixed width. Numbers past 999 get wider;
`reserved_sku` is checked against `^[A-Z]{2,4}[0-9]{3,}$`, which allows that.

This changes the derived **handle** for numbers under 100: `anklets-87-single-piece`
becomes `anklets-087-single-piece`. Only for NEW reservations — handles already in
`product_drafts.reserved_handle` are reused verbatim, never re-derived, because the
handle is the idempotency key for `productSet` (hard rule 2). Re-deriving one would
create a second product.

#### The bug this uncovered — read before touching either implementation

**Postgres `lpad(text, 3, '0')` pads *or truncates* to exactly three characters.**

```
lpad('87',   3, '0')  →  '087'    ✓
lpad('1000', 3, '0')  →  '100'    ✗ silently loses a digit
```

The first cut of `reserve_draft_identity()` used it directly, so the 1000th necklace
would have been issued SKU **NK100** — colliding with a necklace that already exists,
silently, in the one project that exists because two products ended up on `RS221`. The
UNIQUE index on `reserved_sku` would have caught it eventually, which is not the same as
not doing it.

JavaScript's `String.padStart` has never truncated, so the two implementations also
disagreed above 999 and nothing noticed: the test comparing them only ever ran
two-digit counters through the database.

Both sides are now one named concept — `public.pad_sku_number()` wrapping the length in
`greatest(3, length(n))`, and `padSkuNumber()` in `src/lib/publish/identity.ts` — and
`tests/publish-identity.test.ts` compares them directly across `1, 4, 87, 99, 100, 221,
970, 999, 1000, 1234, 12345`, plus an end-to-end reservation that crosses 999.

**Never write bare `lpad(n, 3, '0')` for a SKU number.**

---

### D21 — The material metafield is `custom.material` — a **defined interface**, not an assumption

*Reclassified 2026-07-29. Previously recorded as "unverified, confirm against the live
theme". It is not something to discover; it is something being defined.*

`namespace: "custom"`, `key: "material"`, `type: "single_line_text_field"` — read by a
theme as `product.metafields.custom.material`.

**The live store has no material metafield today.** Descriptions are body HTML, pasted in
by hand, WhatsApp CSS classes and all. So there is no existing convention to match and
nothing to verify against: Loupe is defining this field, and `custom` is Shopify's own
namespace for admin-defined custom data.

That makes the contract one-directional and simple: **the theme template must later read
the same `namespace.key`.** Nothing else depends on the choice. Verified end to end on
the test store — `gid://shopify/Product/8032332283987` carries
`custom.material = "316L"`, read back from Shopify rather than assumed.

**Consequence for D6:** when the six description bullets are moved into the theme, they
read `product.metafields.custom.material`. If a future session finds the theme reading a
different namespace, the theme is wrong, not this.

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

---

### D25 — `productSet` always sends `productOptions`, even for a colourless product

Shopify rejects a `productSet` that supplies `variants` without `productOptions`:

```
input.productOptions: Product options input is required when updating variants
```

The first cut omitted the field when a draft had no colours and passed
`optionValues: []`. Every colourless publish failed — which is most of them, since
colours are optional. Caught by `npm run verify:publish` at criterion 3, where all 20
concurrent publishes failed identically; it did not appear at criterion 1 because that
draft has Gold and Silver.

A colourless product now declares the same pair Shopify creates internally for a
single-variant product:

```
productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }]
variants:       [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }], … }]
```

**Rejected:** inventing a one-value option of our own (`Style: Standard`, or a
single-value `Colour`). Both render as a visible dropdown on the storefront for a
product that has no choice to make. `Title`/`Default Title` is what Shopify's own admin
produces and what themes already special-case into invisibility.

**Note for whoever adds colours to an already-published colourless product:** that is a
genuine product-options change, not a metadata edit, and `productSet` may or may not
accept it in place. Nothing depends on it today; check before relying on it.

---

### D26 — `GOOGLE_SERVICE_ACCOUNT_JSON` is validated, not merely read

Truthiness is not validity, and this variable proved it. It was pasted into `.env` as
raw, unquoted, multi-line JSON:

```
GOOGLE_SERVICE_ACCOUNT_JSON={
  "type": "service_account",
  …
```

dotenv terminates an unquoted value at the newline, so the variable's value was the
single character `{`. A `required()`-style presence check passed. `source .env` in a
shell fails outright on the same input, which is how it was found at all.

Left alone, Phase 3 would have discovered it as a JSON parse error inside a Drive
worker — or, worse, as a worker that started, claimed a lease and then died on every
single file, which reads as a Drive outage for an hour before anyone opens `.env`.

`src/lib/google/service-account.ts` therefore refuses to return a credential it has not
looked inside. It accepts **base64 on one line** (recommended — cannot be broken by a
newline, a quote or a `#`) or intact JSON, and each rejection names *which* mistake was
made rather than reporting a generic failure:

| reason | what it caught |
|---|---|
| `truncated` | the actual bug — dotenv cut it at the first newline |
| `missing` | unset, empty, whitespace |
| `not_json` | a file path, a base64 blob that decodes to junk, truncated JSON |
| `not_an_object` | valid JSON that is an array or a string |
| `missing_fields` | valid JSON, wrong file — an OAuth client secret is the likely one |
| `malformed_private_key` | PEM newlines flattened; parses fine, then fails to sign |

Two surfaces, on purpose: `googleServiceAccount()` **throws**, and Phase 3 must call it
once at worker start-up rather than lazily on the first file. `checkGoogleServiceAccount()`
reports instead of throwing, and `/health` renders it — a broken credential must be
*visible* rather than take the diagnostics page down with it. Only the service-account
address is ever rendered; the private key is never put in a message that might be logged,
which `tests/google-service-account.test.ts` asserts.

---

### D27 — A reserved identity pins its category

`reserve_draft_identity()` freezes `reserved_sku` and `reserved_handle` on the first
attempt and reuses them verbatim on every retry — that is hard rule 2, and it is what
makes `productSet` update the half-made product instead of creating a second one.

But the **title and tag are re-read from the draft's current category on every call**,
deliberately, so that correcting a `title_suffix` between a failed attempt and its retry
publishes the correction. Those two facts combine badly if the *category itself* changes
in between:

```
1. reserved as Necklaces  →  NK005 · "Necklace 005" · necklace-005
2. publish fails
3. operator realises it is a ring, switches the category
4. retry →  SKU NK005 · title "Rings 005" · tag Rings · handle necklace-005
```

A product that reads as a ring, sits in the Rings collection, lives at
`/products/necklace-005`, and carries a number from the **necklace** sequence — while
`RS005` stays unissued and goes to a genuine ring later. Nothing errors. This is exactly
the damage hard rule 1 exists to prevent, and D1 already names misclassification as
high-cost because a wrong category corrupts a *sequence*, not just a row.

**So the identity stays frozen and the category becomes the thing that cannot move.** The
retry path compares the reserved SKU's prefix against the category's and raises if they
disagree, naming both.

**Rejected — re-deriving the SKU:** allocates a second number for one product and orphans
the first.
**Rejected — re-deriving the handle:** breaks hard rule 2 outright; `productSet` would
create a second Shopify product on the next attempt.

The operator's route is a **new draft**, which gets a clean identity from the right
sequence. The abandoned number becomes a gap, and gaps are explicitly harmless here —
`RS218`, `RS220` and `RS222` are already missing from the live store and nothing depends
on them. A product whose SKU prefix disagrees with its category is not harmless.

Phase 2 cannot itself reach this state; nothing in it edits `category_id`. The guard is
here now because the function that must enforce it is being written now, and because the
console that *will* let an operator change a category is Phase 4/5 — by which time this
file is not the one anybody is reading. `tests/publish-identity.test.ts` covers both
directions: the category change is refused, and a corrected `title_suffix` still gets
through on the same frozen handle.

---

### D28 — Drive change cursors use a leased compare-and-swap bootstrap

The watcher stores one opaque Drive `newStartPageToken` in `sync_state`. It never persists
an intermediate `nextPageToken`, and it never uses `files.list` plus modified time.

The first run is deliberately ordered:

1. obtain start token **T0**;
2. reconcile the complete Raw folder;
3. replay the change log from T0;
4. persist only the replay's final `newStartPageToken`.

Taking T0 before the full list closes the only bootstrap gap: a file arriving during that
list is present either in the list or in the replay. The row is leased with a UUID and the
cursor advances only when the same, unexpired lease completes, so overlapping or stale
watchers cannot rewind it. Reconcile remains the independent 15-minute safety net.

**Rejected:** storing each `nextPageToken`. It is a navigation cursor inside one replay,
not the durable checkpoint after that replay.

---

### D29 — Intake attempts count completed work; UUID tokens own claims

`attempts = 0` means no attempt has completed. A newly discovered row is due immediately,
which is the zero-delay first attempt. Claiming it changes the status and leases it but does
not increment the counter. A retryable failure increments the counter and schedules the
next attempt after 1m, 5m, 20m or 1h; completed attempt 5 is terminal.

Every claim returns a fresh UUID `lease_token`. Failure completion requires that token and
an unexpired deadline. Sweep clears both. This is stricter than a deadline alone: after A
expires and B reclaims, late worker A cannot clear B's lease or record B's failure.

**Rejected:** incrementing at claim time. A process crash is not a completed model attempt
and must not consume the photographer's bounded retry budget.

---

### D30 — pg_cron configuration is runtime provisioning, not migration data

Migrations install `pg_cron` in `pg_catalog` and `pg_net` in Supabase's `extensions`
schema. They do not contain the production URL or bearer secret.

`npm run cron:configure` writes those two values to Supabase Vault through a
certificate-and-hostname-verified Postgres connection, then upserts four named jobs:

- `loupe-drive-watch` — every minute
- `loupe-drive-reconcile` — every 15 minutes
- `loupe-intake-sweep` — every 5 minutes
- `loupe-image-enhance` — every minute

The cron command reads Vault at execution time and sends the secret as a bearer header.
`CRON_SECRET` is exactly 32 random bytes encoded as 64 hex characters; runtime and
provisioning enforce the same format. Named `cron.schedule` calls are repeatable, while
direct writes to `cron.job` are not used.

`cron.job_run_details = succeeded` proves pg_cron queued the request; a 2xx row in
`net._http_response` proves the deployed endpoint answered it. Both are checked.

---

### D31 — Phase 3A accepts JPEG, PNG and WebP, with a 50 MB ceiling

Drive metadata is recorded first for every direct, non-folder Raw child. JPEG, PNG and
WebP enter the queue. A missing or different MIME type, or size above 50,000,000 bytes
(the phase's literal 50 MB ceiling), is then
classified as a permanent validation failure with `attempts = 1`, a readable reason and
separate raw detail.

This list is intentionally narrow because HEIC/TIFF decoding and format conversion belong
to the enhancement implementation, not intake guessing. Widening it later is a deliberate
capability change.

---

### D32 — The live acceptance harness supports user-owned Drive uploads

The production service account reads the shared Raw folder, which is all Phase 3A needs.
Google does not grant service accounts personal Drive storage quota, so it cannot create
the 12 acceptance files inside a My Drive folder even when the folder is shared with it.

`npm run verify:intake` therefore has two equivalent fixture paths:

- default: API upload, suitable for a Shared Drive;
- `PHASE3A_EXTERNAL_PREFIX=…`: pause schedules and wait for staged files uploaded through
  an authorised user Drive session.

Discovery, metadata checks and watcher/reconcile/sweep calls still run through the real
service account and production endpoints. In external mode the uploader also owns fixture
cleanup: schedules stay paused until the service account verifies those exact Drive IDs
are gone, then the harness deletes their queue rows and restores the schedules. If owner
cleanup times out, the rows are deliberately retained before scheduling resumes. Test
files are trashed, never moved to Processed, and the fixture path does not change the
application's authentication model.

---

### D33 — The default enhancement prompt matches the existing ivory-satin catalogue

The live default was derived by inspecting approximately 100 existing Qimati product
images. The catalogue is overwhelmingly ivory satin, so the team's original marble
background would make new products look foreign beside the existing 1,600.

Further deliberate edits:

- resolution and aspect ratio were removed from the body and remain API parameters;
- “diamond sparkle highlights” was removed because it instructs the model to add sparkle,
  while roughly a third of the catalogue is plain gold with no stones;
- explicit, repeatable framing was added: centred, 75-80% frame occupancy, even margins,
  and no rotation or restaging;
- fidelity was strengthened so unclear details are reproduced as-is rather than invented,
  and chain links, stones, engraving, clasps, settings and plating colour must match.

The worker reads the live default row at run time and copies its exact `body` to
`image_versions.prompt_text`. It never embeds this text in application code. Changing the
prompt means inserting a new version, retiring the old default and promoting the new one;
historical image rows retain the exact text that produced them.

---

### D34 — Phase 3B uses OpenRouter's dedicated Images API; Step 0 proved the input path

Before any worker code, one real Qimati necklace photograph and the live default prompt were
sent to `openai/gpt-image-2` through `POST /api/v1/images`, with the photograph supplied as
one `input_references` image URL. The call succeeded and the returned scene retained the
specific necklace, proving this route supports image-to-image editing rather than only
text-to-image generation.

The request sent `size: "2048x2048"` and `quality: "high"`. OpenRouter returned a
2048×2048 PNG. Round-trip latency was 222.242 seconds. The response exposed
`usage.cost = 0.44116` USD directly, including prompt/completion cost detail, so the worker
must persist the returned cost rather than estimating it from a price table.

OpenRouter's live model/endpoint metadata advertises `input_references` from 0 through 16.
Only one reference was used in this probe; multi-reference composition was not separately
tested. The same metadata does not advertise mask input, so mask support must not be assumed
for this route.

The saved proof is under `.artifacts/phase3b-step0/` (ignored by Git): the 2000×2000 source,
the 2048×2048 result and `evidence.json`. The throwaway probe was removed after the one call.
No enhancement worker was started in this session.

---

### D35 — Production image calls use 1280×1280 medium with a $0.20 hard ceiling

The business replaced the initial 1024×1024 proposal and the 1536×1536 gate with
`IMAGE_SIZE=1280x1280`. `IMAGE_QUALITY=medium` and
`MAX_COST_USD_PER_IMAGE=0.20` remain the production settings. These values are environment
configuration and must be sent explicitly on every request; provider defaults are never
relied upon. A copy of the source is reduced to a 1024 px long edge before upload.

The one-call gate used the live ivory-champagne satin prompt and a 1024×1024 copy of the
real Qimati necklace. OpenRouter accepted both explicit parameters and returned an actual
1280×1280 PNG:

```text
prompt tokens      1,312
completion tokens  2,096
total tokens       3,408
cost               $0.073376 (response usage.cost, not derived)
round trip          65.358 s
```

This is below the $0.20 ceiling. The first historical call did **not** use an `auto`
default: it explicitly used high quality at 2048×2048, which explains why its
$0.44116 result is not the production baseline.

For the worker, a generation above the configured ceiling is still stored with its actual
cost, then the intake fails permanently with that cost in the readable reason and receives
no retry. The completed worker path is recorded in D36–D39.

---

### D36 — Product descriptions are cached on intake rows and prompt resolution is auditable

Enhancement has two model stages with separate live default prompt rows:
`prompts.kind = 'describe'` and `prompts.kind = 'image'`. The describer sees only the
1024 px-long-edge source copy and the describe prompt. Its factual result, resolved model,
timestamp and actual cost are stored once on `intake_files`; retries and redos reuse it.
Descriptions belong to the source jewellery, not to any particular generated render.

The image prompt uses one literal `{{PRODUCT_DESCRIPTION}}` token. With injection enabled,
plain string replacement inserts the cached text. With injection disabled, an empty cache,
or an exhausted describe path, the PRODUCT heading, placeholder line and following blank
line are removed as one block. `image_versions.prompt_text` stores the exact resolved bytes,
never the template, and the row records `description_injected` and
`description_missing`.

**Rejected:** storing descriptions per generated version. That repeats a paid call for a
fact that does not change and makes the alt-text source depend on which render happens to
be selected.

---

### D37 — Deterministic R2 keys make every enhancement crash point replay-safe

The worker uses the Phase 3A UUID lease token; there is no second claim system. Before every
external write it confirms the same token is still current and unexpired. Database
completion is fenced again inside `complete_intake_enhancement()`, so a worker that finishes
after expiry cannot overwrite its replacement.

Objects use deterministic keys:

```text
originals/{intake_file_id}.{source_ext}
versions/{intake_file_id}/v1.png
versions/{intake_file_id}/v1_thumb.webp
```

Immutable puts compare the expected content/metadata. A retry after an upload recovers the
stored generation only when the source hash, resolved prompt hash, model, size, quality,
cost and description flags match. A conflicting overwrite fails loudly. This closes the
crash window between R2 upload and the database transaction without orphaning a second
version.

Phase 3B never moves a Drive file to Processed. Queue state remains in Postgres; Drive
housekeeping waits for the phase that first produces `published`.

---

### D38 — OpenRouter image references use typed objects, not bare strings

The live OpenRouter `/images` endpoint rejected a bare data URL in
`input_references` even though the earlier probe shape had worked. The current accepted
contract is:

```json
{
  "input_references": [
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,..." }
    }
  ]
}
```

The client and contract test now use that shape. This is a provider wire-format correction,
not a change to Loupe's editing architecture.

---

### D39 — Description failures degrade; image and description spend fail independently

Describe errors are always retryable under the existing 1m, 5m, 20m and 1h backoff. On
completed attempt five the row records `description_missing_at` and the current worker
continues to image generation without a PRODUCT block. The image model still sees the
source photograph, so a describer outage cannot stop catalogue throughput.

`MAX_COST_USD_PER_DESCRIPTION=0.02` guards the first call. The separate
`MAX_COST_USD_PER_IMAGE=0.20` ceiling applies only to the image call. When an image exceeds
that ceiling, its complete version row and actual provider cost remain queryable, the
version is unselected, and the intake fails permanently at that attempt.

A describe response above its ceiling is not retried: the provider already completed the
call, so the same configuration would repeat the overage. It records
`description_missing_at` on attempt 1 and continues to the image call without a PRODUCT
block. Transient describe failures still receive the full bounded retry schedule.

---

### D40 — Keep description injection enabled after the five-product A/B

The production A/B used the same five real Qimati source photographs at 1280×1280 medium.
Image costs were nearly identical:

```text
injected       5 images · $0.390280 total · $0.078056 mean
not injected   5 images · $0.385960 total · $0.077192 mean
describe once  5 calls  · $0.075500 total
```

Single-piece necklace/anklet results were visually similar. The two ring-tray sources were
decisive: without the description the image model collapsed each tray to one invented ring;
with the description it retained the photographed collection as a collection. The cached
description also supplies product alt text regardless of this decision.

`INJECT_DESCRIPTION=true` therefore remains the production default. The one-time describe
cost is accepted for the materially better multi-item fidelity, and a redo still makes zero
describe calls.

---

### D41 — Category-aware composition is a closed enum; application code owns the prose

The Phase 3C describe call returns exactly two JSON fields: a factual paragraph and one of
six presentation classes. The presentation vocabulary is a Postgres enum and an exact
TypeScript tuple:

```text
pair-upright
flat-curve
standing-three-quarter
angled-band
flat-arc
tray-grid
```

This is a staging/composition vocabulary, not a Shopify category classifier. It cannot
choose category, SKU, title, tag or collection. Application code owns one exact composition
paragraph per enum member and replaces the single `{{COMPOSITION_DETAIL}}` token. Model
composition prose is never accepted, stored or sent to the image model.

Strict JSON parsing rejects extra fields, missing fields, non-string values, paragraphs
outside 60–100 words, line breaks and invented presentation values. Bounded retries are
unchanged. On the exhausted malformed/invented path, or for a legacy cached description
without a class, Loupe uses only `flat-curve` and records
`presentation_fallback=true` plus a queryable reason. It does not make a third model call.

**Rejected:** free-form composition text, using the describer as the business category
classifier, and silently accepting a near-match such as `ring`.

---

### D42 — Phase 3C remains incomplete until description cost passes a fresh comparable run

The current-model acceptance used `openai/gpt-5.6-sol` for all five products and
`openai/gpt-image-2` for all five images. It passed the bounded JSON, prompt-resolution,
fallback and visual gates across four presentation classes, but description calls cost
$0.014816–$0.016851 each. The criterion is strictly less than $0.006, so criterion 17 is
failed and Phase 3C is **implemented and visually verified, not complete**.

An isolated description-only comparison tested GPT-5.4 Mini, GPT-5.4 Nano, Gemini 3.1
Flash Lite Preview, Gemini 3 Flash Preview and Claude Haiku 4.5 on the same five sources.
Gemini 3 Flash Preview is the only candidate that passed strict JSON, all five expected
classes, the per-call cost target and manual factual review. Its flat-chain terminology
matches the level of specificity already accepted from the current model, but remains an
explicit fidelity risk for the image gate. The other candidates had a factual or contract
failure: truncation, a wrong class, Markdown-fenced JSON, guessed stones/fittings, or a
rigid-chain misdescription.

Gemini 3 Flash Preview is a **description-only shortlist, not an approved production
change**. Production remains on `openai/gpt-5.6-sol`. A model/provider change requires:

1. an explicit business decision naming the candidate;
2. an updated configuration and evidence record;
3. a fresh comparable five-product acceptance run;
4. strict JSON, acceptable factual descriptions, correct classes and `< $0.006` actual
   provider cost on every item; and
5. visual proof that jewellery fidelity and the 87-item tray count do not degrade.

Description-only evaluation never authorises a silent production swap.

---

### D43 — Description-model selection is deferred past Phase 4; Phase 4 proceeds anyway

*Business decision, 2026-07-30, recorded before any Phase 4 code was written.*

D42 leaves Phase 3C **implemented, deployed and visually verified, but not complete**:
criterion 17 requires every description call below `$0.006` and the accepted
`openai/gpt-5.6-sol` run cost `$0.014816–$0.016851`. That remains true and is not
reinterpreted here.

What the business has decided is *when* that gets resolved: **not now.** Description-model
selection and description-cost optimisation move to a later final optimisation stage,
after the operator console exists. The reasoning is that the console is what converts
enhanced photographs into revenue, and roughly $0.016 per product at ~300 products/month
is about ₹400 a month against a ₹5,000 budget — real, but not worth blocking the one
remaining piece of the pipeline that nobody can work around.

What that decision does and does not authorise:

| | |
|---|---|
| Phase 3C status | still **not complete**; criterion 17 still failed |
| implementation | stays deployed and unchanged |
| `DESCRIBE_MODEL` | stays `gpt-5.6-sol` — unchanged |
| `DESCRIBE_REASONING_EFFORT`, `IMAGE_MODEL`, `IMAGE_SIZE`, `IMAGE_QUALITY` | unchanged |
| prompt architecture, presentation classes, provider configuration | unchanged |
| the Gemini 3 Flash Preview shortlist | **evidence only** — still not authorised for production |
| Phase 4 | allowed to proceed with the cost criterion unresolved |
| model/provider selection | **out of scope for Phase 4** |

The five conditions in D42 for a production model change are untouched and still all
required. Nothing in Phase 4 may change a describe/image model, ceiling or prompt, and no
Phase 4 work may re-run the paid Phase 3C acceptance set.

**Rejected:** marking Phase 3C complete because the business is content to live with the
cost. Deciding to defer a criterion is not the same as meeting it, and a phase marked
complete on a failed criterion makes every other "complete" in PROGRESS.md worth less.

---

### D44 — Google sign-in is a direct OAuth client, not Supabase Auth

Phase 4 needed Google sign-in. Two routes were available and the choice is not
obvious, so here is why it went the way it did.

**Supabase Auth's Google provider** would have handled the redirect dance. What it
would also have done is hand the browser an `authenticated` JWT — and every table
in this schema has RLS enabled with **zero policies** (D11), so that token can
read exactly nothing. It would be a credential whose only purpose is to be
ignored. Meanwhile the Google client secret would have to live in the Supabase
dashboard, which is a second place to keep a secret and a second place to look
when sign-in breaks.

**A direct OAuth client** keeps the whole flow inside this repository:
`/api/auth/google/start` mints `state` + a PKCE verifier into a short-lived
httpOnly cookie, `/api/auth/google/callback` exchanges the code server-to-server,
and the result is a session cookie signed with `AUTH_SESSION_SECRET`. The client
secret is read through `serverEnv`, which starts with `import 'server-only'`, and
`npm run verify:isolation` now scans the built client assets for it and for the
session secret.

`.env.local.example` has reserved `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` "Phase 4" since Phase 1 — the same conclusion,
reached earlier. This decision records the reasoning rather than inventing it.

Consequences worth knowing:

- **The cookie is a claim, not a grant.** It carries an `app_users.id`, and every
  protected surface re-reads that row and requires `active = true`. Deactivating
  an operator takes effect on their next request, not when their token happens to
  expire. The `role` in the cookie is for display and for the audit actor; nothing
  authorises on it.
- **`AUTH_BASE_URL` is configured, never derived from the `Host` header.** The
  redirect URI must match the OAuth client's registration exactly, so deriving it
  breaks behind a proxy *and* lets a forged Host move where Google sends people.
- **`prompt=select_account` is always sent.** Without it a signed-out operator is
  bounced straight back in on whichever Google account the browser last used —
  which also makes "prove an unauthorised account is refused" impossible to
  demonstrate.
- **The ID token's signature is not re-verified locally.** It is read from the
  response of a TLS request Loupe itself made to Google's token endpoint, with no
  untrusted party in between; that is Google's own documented guidance. Issuer,
  audience, expiry and `email_verified` are all still checked. A token arriving by
  any other route would need JWKS verification — and no such route exists.

**Rejected:** adding an RLS policy so the browser could read the queue directly.
D11 makes browser-side harmlessness structural rather than remembered, and
"it would simplify the UI" is precisely the reason that decision anticipated.

---

### D45 — The image requirement is enforced in TypeScript, not in the SQL

Every other publish invariant is checked twice — readably in
`src/lib/publish/validate.ts` for the operator, and again as a `raise` inside
`reserve_draft_identity()` so nothing that reaches the database another way can
route around it (D18). "At least one image" is deliberately **not** in the SQL
half, and the asymmetry is worth explaining rather than discovering.

`npm run verify:publish` — the Phase 2 harness that proves SKU allocation, handle
idempotency and blocking behaviour — publishes bare drafts. There is no Drive
file, no R2 object and no photograph behind them, and there should not be: it is
testing the counter, not the catalogue. A SQL-side image requirement would have
made that harness impossible to run without inventing fixtures for it.

The two are also not equally dangerous. A missing tag drops a product out of its
collection silently and a wrong SKU corrupts a *sequence*; a missing image is
visible on the product page the moment anyone looks. So the guard lives where the
operator is, and `requireImages` defaults to **true** — opt-out, not opt-in, so a
future caller that never thinks about images fails closed. `verify:publish` opts
out in one place, with a comment saying why.

---

### D46 — Publishing takes a lease on the draft

Two rapid Publish clicks were already safe in the ways that matter most:
`reserve_draft_identity()` takes `FOR UPDATE`, so one identity; `productSet` is
addressed by handle, so one product. What was **not** safe was media. Two
publishes racing past each other could both read "this product has no images yet"
and both upload the same files, and Shopify would accept it — the presigned URLs
differ every time, so nothing on its side can tell the two uploads apart.

So `begin_draft_publish()` / `end_draft_publish()` wrap the console's publish with
the same UUID compare-and-swap the intake worker uses (hard rule 6). A second
Publish while one is in flight is refused with a sentence the operator can read;
an **expired** lease is reclaimable, so a publish that crashed mid-flight is
retryable and self-heals rather than stranding the draft forever.

The release is fenced by the token: a publish that overran its lease cannot
unlock the attempt that replaced it. Client-side double-submit prevention exists
too, but only for usability — correctness is the database's.

---

### D47 — A draft image remembers which Shopify media it became

`product_draft_images.shopify_media_id` is recorded after every successful
publish, read back from Shopify rather than assumed from the mutation's reply.

It exists because `productSet`'s `files` is declarative: passing `id` keeps a file
Shopify already holds, and passing `originalSource` uploads a new one. Without a
recorded id there is no way to tell those apart, because the presigned URL is
different on every publish — so a retry, or a re-publish after a reorder, would
upload the same photographs again and the product would grow duplicate media.

With the id, a **reorder** simply lists the same media in a new order, and the
picture moves instead of being uploaded beside itself.

One case has no recorded id and still must not duplicate: a publish interrupted
after Shopify accepted the files but before Loupe wrote them down. There, the
media list is read back before publishing and, when the product already carries
exactly as many media as we are about to send, they are treated as ours in order
and repaired. That is a narrow, deliberate assumption — it only fires when the
counts match exactly and no draft image already claims an id.

---

### D48 — Alt text is the cached description, trimmed but never invented

Each selected image's Shopify alt text is `intake_files.product_description` for
**that** source photograph — the factual paragraph the describer already produced
and Loupe already paid for (D36). The console makes no model call of any kind.

Two deterministic departures, both recorded rather than silent:

| case | what happens |
|---|---|
| longer than Shopify's 512-character limit | trimmed at the last sentence that fits, else the last word. No ellipsis — alt text is read aloud and "…" is noise in a screen reader. Nothing is added, only dropped from the end. |
| no cached description (the describer degraded, D39) | the product's own title: `"Necklace 005 — product photograph"`. |

A 60–100 word description lands close to 512 characters, so the trim is a real
path and not a theoretical one; `buildAltText()` is pure and tested at the
boundary.

The fallback deliberately invents no jewellery detail. Qimati's buyers are
retailers who zoom in to judge build quality before staking their own reputation
(docs/CONTEXT.md) — a fabricated "gold-plated" in alt text is a claim they would
be entitled to rely on. The presentation class is not used either: it is a
staging vocabulary, not a description of the piece (D41).

---

### D49 — Shopify store currency is authoritative

*Business decision, 2026-07-30.*

Loupe continues to write a currency-less decimal price. Shopify interprets it in the
currency configured on the target store. Loupe does not convert, label or override
currency.

The test store may therefore remain USD. Phase 7 must confirm the live store currency
before cutover; the live store's configured currency is the intended production currency.

**Rejected:** adding a Loupe currency selector or converting rupees into the test store's
USD. Either would create two sources of truth and could silently publish a converted price
as a nominal price.

---

### D50 — Product descriptions are written per product, with a safe default and a rare override

*Business decision, 2026-07-30. This supersedes D6.*

The theme change anticipated by D6 was never made, so a metafield-only Loupe product has
no visible description. The owner has chosen self-contained product descriptions instead:

- Loupe still writes the selected material to `custom.material` (D21);
- Loupe also writes clean `descriptionHtml` built from Qimati's six standard bullets;
- the selected material is inserted into the first bullet;
- the operator may choose one of the controlled materials or enter a one-off custom
  material;
- the operator may rarely edit the default six-bullet text for one product, or reset it to
  the default.

Custom material is stored on the product draft, not inserted into the global `materials`
vocabulary. This keeps a one-off entry from becoming a permanent suggestion while still
allowing it to carry as a browser-local sticky value during a batch.

The override is stored as plain text and escaped before Loupe produces HTML. Operators
never edit raw HTML, and WhatsApp CSS/classes cannot be reintroduced through this field.

**Rejected:** theme-only rendering (the description is absent until a separate theme
deployment), free-form HTML, and adding every one-off custom material to the global list.

---

### D51 — Phase 5 offers ten curated models per enhancement stage

*Business decision, 2026-07-30. This supersedes D43 only for model selection after
Phase 4; D43 remains the reason no model changed during Phase 4.*

The Prompt screen has two independent model selectors:

- ten image-capable text models for the descriptor, ordered from lowest cost to premium;
- ten image-edit models for generation, also ordered from lowest cost to premium.

The lists are curated against OpenRouter's official model and image-model endpoints, not
loaded as an unbounded provider catalogue. Each option has a stable provider-qualified
slug, a cost tier and a concise use note. Prices shown in the interface are hints;
OpenRouter billing and Loupe's recorded `usage.cost` remain authoritative.

Changing a model creates a new immutable prompt row with the same body and the new model,
archives the prior default and records `prompt.model_selected`. The worker reads the model
from the same current prompt row as the body, so prompt and model cannot drift into two
configuration histories. A switch is refused while an enhancement lease is active.

The current accepted defaults remain selected:

```text
descriptor        openai/gpt-5.6-sol
image generation  openai/gpt-image-2
```

OpenAI image models keep explicit size and quality parameters. Other curated image models
use OpenRouter's common 1:1 edit contract; Loupe converts a square result to the configured
1280×1280 PNG and refuses a wrong aspect ratio. Size, quality, reasoning effort and
provider credentials are not user-selectable.

**Rejected:** listing every OpenRouter model, accepting an arbitrary slug, changing the
provider key, silently changing the current default as part of deployment, or treating a
model selection as acceptance evidence. A newly selected model still has to prove
structured description output, jewellery fidelity and cost before Phase 3C can complete.

---

### D52 — Image redo is a durable, image-only job with a conservative paid-call fence

*Implementation decision, 2026-07-30.*

A redo is not performed as an untracked browser request. Loupe first creates an
`image_redo_jobs` row that captures the current image prompt, selected model, cached
description flags, original source version and a reserved next version number. The worker
then writes the generated image to a deterministic R2 key before completing the database
job. A crash after the R2 write recovers that object and makes no second model call.

The job records `generation_started_at` immediately before dispatching the paid request.
If the worker later finds that marker but no durable R2 result, it refuses to
automatically call the provider again: the first request's billing outcome is unknowable.
The operator may deliberately start a new redo, which gets a new job and version number,
but one job never makes two potentially paid calls.

Redo always reuses `intake_files.product_description` and `presentation_class`; it never
invokes the descriptor. The resulting version is appended and remains unselected until
the operator reviews and chooses it.

**Rejected:** doing the generation only inside a server action (a timeout loses its
state), overwriting version 1, automatically selecting an unseen redo, and retrying an
ambiguous paid request.

---

### D53 — Duplicate warnings use a 64-bit source pHash with an explicit review pair

*Implementation decision, 2026-07-31.*

Loupe computes a deterministic 64-bit perceptual hash from the decoded source photograph:
32×32 greyscale pixels, a two-dimensional DCT, and the median-thresholded 8×8 low-frequency
block. Two photographs at Hamming distance 8 or less are possible duplicates.

The threshold is deliberately a warning threshold, not a correctness boundary. A
`duplicate_reviews` row stores the canonical ordered pair and the operator’s decision,
preventing the same dismissed pair from returning while preserving who decided and why.
Only an ungrouped photograph may be marked duplicate; grouping or publishing wins over a
late duplicate action. Dismissal never changes either photograph.

**Rejected:** exact checksums (miss resized/recompressed copies), a learned similarity
model (non-deterministic and paid), silently deleting one file, or blocking publish on a
distance threshold.

---

### D54 — Shopify reconciliation is read-only, durable and single-run leased

*Implementation decision, 2026-07-31.*

The daily reconciliation reads every `published` Loupe draft from Shopify in bounded
batches and compares identity plus catalogue fields that Loupe owns: product existence,
status, handle, title, product type, required tags, description, material, variants and
recorded media. Each run and mismatch is stored immutably and audited.

One database lease admits a single active run. Overlapping cron or manual requests return
the active run instead of issuing the same full-store read twice. A failed run remains
visible with its readable error; a later daily run is a new record.

Reconciliation never edits Shopify and never rewrites a draft to match observed drift.
Repair requires a separate deliberate operator workflow after the mismatch is understood.

**Rejected:** automatic “healing” (could overwrite an intentional Shopify edit), comparing
only row counts, keeping only the latest result, and running one unbounded request per
product.

---

### D55 — Reasoning-effort suppression applies to every reasoning-capable curated describer, not only OpenAI

*Business decision, 2026-07-31: the owner selected `google/gemini-3.1-pro-preview` as the
describe model from the Phase 5 selector (D51) and its very first live call failed.*

`supportsReasoningControl()` sent OpenRouter's unified `reasoning: {effort, exclude}`
control only when `model.startsWith('openai/')`. That predates D51's multi-provider
describe selector — it was written when `gpt-5.6-sol` was the only describe model that
existed — and nobody revisited it when D51 exposed nine more. OpenRouter's own
documentation states the parameter is normalised across OpenAI, Anthropic, Google Gemini
"thinking" models and Qwen, not OpenAI alone.

The consequence was live and immediate: `google/gemini-3.1-pro-preview` received no
effort/exclude control, spent its completion budget on unsuppressed reasoning (billed even
with `exclude: true` — the docs are explicit that excluded reasoning is still generated and
charged, just not returned), and returned `` ```json\n{"description": `` — fenced *and* cut
off before any content. `parseStructuredDescription()` correctly rejected it
(`invalid_json`); that parser stays exactly as strict as D41 requires — rejecting fenced or
prose-wrapped JSON is deliberate and tested (`tests/presentation.test.ts`), and this
decision does not touch it. The fix belongs upstream, in making the request itself produce
bare JSON regardless of which curated model is selected.

`REASONING_CAPABLE_PREFIXES` in `src/lib/enhance/openrouter.ts` now covers
`openai/`, `google/`, `anthropic/` and `qwen/` — every family OpenRouter documents as
supported, which is also every family in the ten curated describe models
(`src/lib/prompts/models.ts`). `max_completion_tokens` also moved 256 → 512 as a margin for
suppressed-but-billed reasoning tokens; `MAX_COST_USD_PER_DESCRIPTION` still bounds actual
spend independently, so this does not weaken that ceiling. `MAX_COST_USD_PER_IMAGE` (D35,
$0.20) is untouched and was already fully model-agnostic — it checks the provider's actual
reported `usage.cost`, never a token estimate, regardless of which curated image model is
selected.

**Rejected:** loosening `parseStructuredDescription()` to strip a markdown fence before
parsing. That would weaken a deliberate, tested strictness boundary (D41) to paper over a
symptom instead of the cause, and would not have fixed this specific failure anyway — the
captured response was truncated mid-value, not merely fenced; stripping the fence alone
still leaves incomplete JSON. **Rejected:** sending `reasoning` unconditionally to every
model string. The curated list is bounded (D51) and OpenRouter does not document behaviour
for a reasoning-incapable model receiving the parameter, so scoping to the four confirmed
families is the evidence-grounded choice rather than an assumption.

---

### D56 — The Gemini describe failure was the markdown fence, not reasoning tokens; the prompt was fixed directly, not guessed at again

*Correction, 2026-07-31, same day as D55. A second live failure on
`google/gemini-3.1-pro-preview` after D55 shipped — same symptom, fenced/truncated JSON —
forced an actual empirical test instead of a second theory.*

Two real calls were made to `google/gemini-3.1-pro-preview` through the live
`OPENROUTER_API_KEY`, same prompt, same image, `reasoning: {effort: 'minimal', exclude:
true}`, `max_completion_tokens: 3000`:

```text
A: current prompt body            → completion_tokens 121, reasoning_tokens 0, finish_reason
                                     "stop" (NOT truncated) — but wrapped in ```json anyway
B: prompt + explicit "no markdown, → completion_tokens 122, reasoning_tokens 0, finish_reason
   raw JSON only" instruction         "stop" — clean bare JSON
```

This overturns D55's working theory. Reasoning tokens were not the dominant cost in either
call (`reasoning_tokens: 0` both times, well under the old 256/512 ceiling) — the model
simply defaults to wrapping JSON in a markdown fence regardless of reasoning settings, and
`parseStructuredDescription()` correctly, deliberately rejects that (D41). D55's earlier
live failure that looked like pure truncation was most likely an unlucky call landing on
the opaque, provider-controlled reasoning spend OpenRouter's own docs warn about for Gemini
3 (`thinkingLevel` — "the actual number of reasoning tokens consumed is determined
internally by Google... no publicly documented token limit breakpoints") — real, but not
the dominant failure mode.

Two changes, evidence-scoped to what was actually measured:

1. The live `describe` prompt was updated through the proper Phase 5 mechanism —
   `create_prompt_version()` then `promote_prompt_version()`, actor
   `script:describe-prompt-fence-fix`, fully audited — appending: *"Output raw JSON only. Do
   not wrap it in markdown, code fences, or triple backticks. The response must start with {
   and end with } and contain nothing else."* Not a raw `UPDATE` — prompts are immutable,
   versioned, audited data (D51), and a direct write would have bypassed that contract even
   though the effect was correct. Because D51 already carries a prompt's body forward
   verbatim when the model changes, this instruction now benefits every future model
   selection automatically, not only Gemini.
2. `max_completion_tokens` raised again, 512 → 1500 (src/lib/enhance/openrouter.ts). Not
   because 1500 was measured as necessary — 121-122 tokens sufficed in both real calls — but
   because Gemini's own reasoning spend is documented as opaque and non-deterministic, so a
   generous margin absorbs an occasional heavy call without the request-level ceiling being
   the thing that turns it into truncated garbage. `MAX_COST_USD_PER_DESCRIPTION` still
   bounds actual spend from the real reported cost regardless of this number (D39) — a call
   that genuinely runs long is still caught there, just by the ceiling that was designed to
   catch it, not by an undersized request parameter.

**Rejected:** trusting the first fix without a real call. D55 was reasoned correctly from
OpenRouter's documentation but was not empirically verified against the specific model in
production, and it shipped anyway — the second failure is the direct cost of that. **Not
repeated here**: both changes in this decision were checked against real OpenRouter
responses before being promoted to the live prompt.

---

### D57 — Intake accepts GIF and TIFF; HEIC/HEIF stays rejected until decoding is verified

*Implementation decision, 2026-07-31, prompted by the owner asking for broader format
support alongside the describe-model fix.*

`sharp`/libvips in the deployed environment (checked directly via `sharp.format` and
`sharp.versions` at runtime, not assumed) reports working `gif` and `tiff` codecs. Both were
added to `discover_intake_file()`'s MIME allowlist and to `originalExtension()` in the
enhancement worker (`supabase/migrations/20260731120000_widen_intake_image_formats.sql`),
per D31's own anticipation that widening the intake format list would be "a deliberate
capability change" made later, on evidence.

HEIC/HEIF — the default iPhone camera format — was deliberately left out. The same runtime
check shows `sharp.format.heif.input.fileSuffix` lists only `.avif`: libheif is present, but
without the licensed HEVC decoder that real `.heic` files are encoded with. Accepting the
MIME type at intake without being able to decode it later would trade a clear, immediate
"unsupported format" rejection for a confusing failure deeper in the enhancement worker.

**Rejected:** accepting `image/heic` on the assumption that "the HEIF library is present, so
it probably works" — the fileSuffix list is direct evidence it does not, and this project's
standard is verifying provider/library contracts, not inferring them. Real HEIC support
needs either a differently-built image library or an explicit conversion step, and is future
work if the photographer's camera actually produces `.heic` files — nothing observed in
production so far has.

---

### D58 — Serverless functions run in Mumbai (`bom1`), beside the database

*Performance decision, 2026-07-31, measured rather than assumed.*

There was no `vercel.json`, so functions defaulted to `iad1` (Washington DC) while Supabase
is `ap-south-1` (Mumbai), the R2 bucket is APAC (D4) and the operators are in Jaipur. Every
database round trip crossed the Pacific twice. Confirmed from the response header rather
than inferred — `x-vercel-id: bom1::iad1::…` means the Mumbai edge accepted the request and
a Washington DC function served it.

This is not one slow query, it is a latency multiplier on every wave of them. `/console`
issues several dependent waves — authorise, then queue, then the grouped photographs of
those drafts, then their versions — and each wave paid the full intercontinental round trip.

Measured against `/health`, which is a fixed set of counts and therefore a fair before/after:

```text
iad1 functions   0.738s · 1.101s · 1.289s
bom1 functions   min 0.331s · median 0.369s · mean 0.455s   (6 warm runs)
```

Roughly a 3× improvement at the median, and it compounds on the console, which does far
more database work than `/health`. `regions: ["bom1"]` in `vercel.json` is now the pinned
choice. Note the first request after any deploy is a cold start (4.18s was measured
immediately post-deploy) — that is the function booting, not the region, and it does not
recur while warm.

**Rejected:** moving the database to `iad1` instead. The bucket is already APAC and the
operators are in Jaipur, so the database is in the correct place and the compute was not.
**Rejected:** leaving it and caching harder. These screens re-check authorisation and
re-sign image URLs on every render by design (D11, D4); the correct fix is to make the
round trip short, not to cache the things that must not be cached.

---

### D59 — Every protected screen has a `loading.tsx` boundary

*Implementation decision, 2026-07-31.*

`/console`, `/tracking` and `/prompts` are all `force-dynamic`. Without a `loading.tsx`,
Next.js App Router holds the PREVIOUS page on screen for the entire server round trip, so
clicking Tracking produced no visible change until the new page was fully ready — which
reads as a dead control and invites the second and third click the owner reported.

Each route now renders `ScreenSkeleton` in its own Suspense boundary: the sidebar column,
header and card geometry of the real screen, so navigation acknowledges the click instantly
and the layout does not jump when real content arrives. This is presentation only — no
authorisation decision is made in a skeleton, and the real screen still re-runs
`requireOperator()` before reading any data.

**Rejected:** a centred spinner (loses the layout, causes a visible jump) and making the
screens static or cached (they are dynamic for authorisation and presigned-URL reasons that
D11 and D4 make structural).

---

### First fix that shipped without being checked — read before repeating the mistake

D55 was deployed on documentation and reasoning alone. It was directed at a real, correctly
diagnosed class of problem (reasoning-capable models restricted to `openai/` only) and the
change itself was not wrong — but it was not the actual cause of the failure it was meant to
fix, and a second live failure on the owner's real upload was the cost of finding that out
in production instead of before shipping. D56 corrected it with two real API calls that
cost a few cents and took under thirty seconds. The project's own standard already says
this — "Provider contracts must be verified against real requests," docs/CONTEXT.md — the
gap here was applying it to a fix, not only to original implementation work.


---

### D60 — Save Draft creates a real Shopify product with status DRAFT

*Business decision, 2026-07-31. Supersedes D7's "no Shopify draft stage"; the rest of D7
stands.*

D7 kept drafts inside Loupe so that Publish was the single approval step. The owner wants an
unfinished product visible in Shopify, where the rest of the team already works, rather than
only inside Loupe. That is a reasonable reason to reverse the decision, and it was taken
explicitly rather than drifted into.

**The consequence that had to be accepted first.** A Shopify product needs a SKU and a
handle, and the handle is the idempotency key for `productSet` (hard rule 2). So drafting to
Shopify allocates the SKU at DRAFT time instead of at publish, and a draft that is abandoned
burns that number permanently. Gaps are survivable here — `RS218`, `RS220` and `RS222` are
already missing from the live store and nothing depends on contiguity (D27) — but this is a
real, irreversible cost per abandoned draft, and the owner accepted it knowingly.

What changed, and what deliberately did not:

| | |
|---|---|
| `reserve_draft_identity` | gains `p_require_publishable boolean default true` |
| that flag relaxes | **the price guard only** |
| still enforced for a draft | category present, confirmed Shopify tag (D23), D27 category pin |
| still enforced for publish | every block in hard rule 8, unchanged — the default is `true` |
| Loupe draft status | returns to `assembling`; a Shopify draft is not "published" |
| Drive housekeeping | does **not** run for a draft — /Processed means the photograph is done |
| images | not required for a draft; still required to publish (D45) |

The old two-argument function is **dropped** rather than left beside the new one. Adding a
parameter in Postgres creates an overload, and two live versions of the function that
allocates SKU numbers is exactly the ambiguity this project cannot afford.

`record_draft_shopify_product()` is separate from `mark_draft_published()` on purpose. The
latter means "this is in the live catalogue" and also publishes the intake rows and counts
colour usage; a Shopify draft is none of those things. It also resets the draft from
`publishing` back to `assembling` — the first cut did not, and the deployed-SQL check caught
a draft left permanently mid-publish, uneditable in the console and reported as stalled by
Tracking within the hour.

A Shopify draft with no price yet is sent at `0.00` because Shopify requires a number. It can
never be *published* at that figure: hard rule 8 still blocks an empty or zero price on the
ACTIVE path, so the placeholder cannot escape into the live catalogue.

Saving is **not** failed when Shopify is unreachable. The operator's typing is already in
Postgres by that point, and losing it because a third-party API blinked is a worse outcome
than a draft that has not reached Shopify yet. The failure is reported to the operator, and
the next save retries against the same reserved handle.

**Rejected:** relaxing the price guard globally instead of behind a flag — that is hard rule
8, and the whole point of D18 is that the database enforces it independently of the UI.
**Rejected:** a second "Send to Shopify" button (offered and declined; the owner wants Save
Draft itself to do this). **Rejected:** reusing `mark_draft_published` for drafts, which
would have published the intake rows and counted colour usage for a product nobody has
approved.

---

### D61 — Client navigation is cached for 30 seconds; the auth lookup is memoised per request

*Performance decision, 2026-07-31.*

Two caches, both deliberately narrow, added after D58/D59 left switching sections still
paying a full round trip each way.

`experimental.staleTimes.dynamic = 30` lets the App Router reuse an already-fetched section
for 30 seconds. Every screen is `force-dynamic`, so without it the router re-fetched the
whole payload on every navigation, including bouncing straight back to a section the operator
had just left. Thirty seconds is matched to how the tool is used: new work arrives from Drive
on a cron measured in minutes, and the console separately polls its own counters every five
seconds and refreshes when work completes, so a cached shell cannot hide finished work.

`currentOperator()` is wrapped in React's `cache()`, which memoises **per request**. One
render can authorise several times across the page and the components and actions it fans out
to, and each of those was a separate round trip to a database in another region.

Neither is a security boundary, and this is the part worth being explicit about: the memo
dies with the request, and authorisation is still re-read from `app_users` on the operator's
very next request and inside every server action (D44). Deactivating someone still takes
effect immediately. A cached navigation payload cannot authorise anything — every mutation
re-checks server-side before it touches the database.

**Rejected:** caching the queue or draft data itself. Those must stay live — a stale queue
is how two operators group the same photograph — and D11 makes the browser structurally
unable to read the database directly anyway.


---

### D62 — R2 objects are deleted 7 days after a product reaches Shopify; the rows are kept forever

*Business decision, 2026-08-01.*

Nothing deleted anything from R2 before this, so every original (up to 50 MB) and every
generated version accumulated indefinitely. Retention now runs daily and purges a
photograph's objects seven days after its product reached Shopify — by EITHER route:
published, or saved there as a draft (D60).

The bytes are genuinely redundant at that point, from two independent directions: Shopify
serves the published image from its own CDN, and Google Drive `/Processed` still holds the
untouched original. The owner chose to purge everything for the photograph — original,
generated versions and thumbnails — rather than versions alone, because the original is the
largest file and keeping it saves little.

**What is deleted and what is emphatically not.** The `image_versions` ROW is never deleted.
It carries the exact model and exact `prompt_text` behind every published image, and that
record is the entire mitigation for silent style drift (D5) — it is what makes "these forty
products look different, and here is the model string that produced them" answerable months
later. A new `purged_at` column marks that the bytes are gone; the audit trail outlives them.

Two mechanics worth knowing:

- `shopify_first_sent_at` is stamped by a **trigger** on the null → non-null transition of
  `shopify_product_id`, not by editing `mark_draft_published` and
  `record_draft_shopify_product`. The trigger catches every route into Shopify including any
  future one, and cannot drift out of step with them. Re-publishing does not restart the
  clock.
- A version is marked purged only when **every** one of its objects actually deleted. Marking
  it after a partial failure would strand the survivor: nothing would ever look at that key
  again and it would sit in the bucket permanently, invisible and still billed.

**Rejected:** deleting the `image_versions` rows to reclaim a few hundred bytes, which would
trade the drift audit trail for nothing. **Rejected:** running retention continuously —
deleting bytes is the least urgent thing Loupe does and the least reversible, so it runs once
daily in the quiet window after reconciliation.

---

### D63 — A redo shows its prompt before it is paid for, and may be edited for that product only

*Business decision, 2026-08-01.*

"Redo image" spent roughly $0.07 immediately, on a prompt the operator could not see. It now
opens the exact resolved text — description injected, composition paragraph substituted —
and lets the operator edit it before pressing Continue.

An edit applies to **that redo only**. It is deliberately not a new prompt version: prompts
are immutable, versioned and audited (D51), and a tweak for one awkward photograph must never
quietly become the catalogue-wide default. `image_redo_jobs.prompt_override` records that a
human edited it; `image_versions.prompt_text` still stores the exact bytes sent, so a redo
from an edited prompt stays exactly as traceable as any other.

The operator edits the RESOLVED prompt, so no `{{TOKEN}}` should survive. One is refused
rather than sent — the image model would receive it as literal text and quietly degrade the
result. Resolution is shared with the queueing path so the preview cannot drift from what is
actually sent.

---

### D64 — Skipped work is "on hold": resumable, or discarded out of RAW

*Business decision, 2026-08-01.*

Skipping was terminal and invisible — the row sat in Tracking's All list reading "Skipped"
while the file stayed in RAW, rescanned every fifteen minutes forever. Held work is now
first-class:

- it is classified as **On hold** in the in-progress group, where an operator will look for
  it, rather than filed under complete;
- **Resume** returns it to the queue with a **fresh retry budget**. A hold is a human
  decision, not a failure; inheriting spent attempts would leave resumed work one error from
  terminal (hard rule 4);
- **Discard** removes it for good.

Discard's ORDER is the whole design, and both alternatives are wrong. Drive file out of RAW
first, then the R2 objects, then the database row. Deleting the row first strands a file in
RAW that Loupe no longer knows about — the watcher rediscovers it within a minute and it
reappears in the queue, which is precisely the confusion this feature exists to end. Every
step before the last is idempotent, so a failure part-way leaves the row intact and the
operator simply presses Discard again.

The Drive file is **moved to a `/Discarded` folder, not trashed**. Phase 4 proved the service
account cannot trash a file owned by the operator's own Drive; moving it out of RAW is what
actually matters. `DRIVE_DISCARDED_FOLDER_ID` is optional and falls back to the Processed
folder, so the feature works before that folder exists.

**Rejected:** leaving the Drive file in RAW and only removing the Loupe row — the watcher
would simply rediscover it. **Rejected:** allowing discard of grouped or published work;
both are refused in SQL as well as in the UI.

---

### D65 — A style preset is a PAIR of prompts, and the pair moves together

*Reported from the live console, 2026-08-01.*

Two defects, both from the same root cause: presets were built as image prompts only.

**"Add or remove the composition token so it appears once."** `validate_prompt_body()`
predates `uses_composition` and demanded exactly one `{{COMPOSITION_DETAIL}}` token from
*every* image prompt. The hand-chain and bag presets deliberately carry none, so they could
be saved but never promoted — D51's "create, then deliberately promote" flow was broken for
exactly the presets that most needed it. Validation now takes the staging flag and requires
one token or zero accordingly, refusing **both** directions.

**Half a preset was a reachable state.** Promoting the image half alone left the accepted
describer — written for jewellery lying on a surface, forbidding any mention of a hand,
speaking in stones and clasps and prongs — feeding the hand-chain and bag prompts. Every
preset now has a describe half joined by `preset_slug`, and `promote_prompt_preset()`
promotes both inside one transaction. Marble and yellow reuse the accepted describer
byte-for-byte: a described piece must not change because the surface under it did.

**`uses_composition` is DERIVED from the body, never asked for.** One token means the
describer composes; zero means the prompt stages the product itself; two or more is refused
with its own message. The flag and the tokens therefore cannot disagree, and editing a
preset body needs no second control that could be set wrongly. The cost is that deleting the
token silently *changes* a prompt's meaning instead of erroring, so `/prompts` states which
of the two was saved in the confirmation line.

**The bug this class of change exists to catch:** `promote_prompt_version()`'s
reactivation branch copied name, body, kind and model — but not `uses_composition` or
`preset_slug`. Since every preset ships archived, that copy is the *only* path a preset can
be promoted through. It would have produced a live prompt flagged describer-composed with no
token in its body, and `resolveImagePrompt()` would have thrown on every enhancement from
that moment. It is now covered by a test that asserts the promoted copy's flag *and* its
token count.

**Rejected:** letting the describer keep choosing a composition class for the self-staging
presets and ignoring it in code — the class would still be recorded against the photograph
and read as meaningful later. It is recorded and explicitly documented as unused instead.
**Rejected:** a `uses_composition` checkbox on the create form. See D51 — one more control
that can contradict the text next to it.

---

### D66 — The accepted prompt is a preset too, and feedback is dismissible

*Reported from the live console, 2026-08-01.*

Two follow-ups to D65, both found by the owner using the picker rather than reading it.

**The picker offered four alternatives and no way back.** The live pair carried no
`preset_slug`, so nothing read as "in use" and an operator who tried marble had no button
that returned them to the prompt the catalogue was actually built on. The accepted pair is
now the `satin` preset — and it is genuinely not marble: the accepted background is
ivory-champagne satin with soft folds.

The two live rows are **tagged, not copied**. A copy would have to be kept byte-identical to
the accepted body forever, and the first time the two drifted the preset would quietly stop
being the thing it claims to be.

**"Add or remove the composition token so it appears once." would not go away.** The string
no longer existed anywhere in the deployed database — every action on `/prompts` returns its
outcome in the query string, so the failed attempt had pinned its message to the address bar
and every reload re-rendered it. A stale error is indistinguishable from a live one, which
is worse than no message: it makes a fixed thing look broken.

Every banner now carries **Dismiss**, a plain link to the clean URL. No client JavaScript, so
it cannot fail to clear. **Rejected:** stripping the parameter with `history.replaceState`
after mount — a real error would vanish before it was read.
