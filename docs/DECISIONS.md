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

Product-option swatches are semantic catalogue data, not interface accents. D71 allows them
inside the colour picker and product preview while all surrounding console chrome remains
neutral.

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

---

### D67 — Tracking shows a thumbnail for drafts and Shopify mismatches too

*Reported from the live console, 2026-08-01.*

Only intake rows had a picture. `thumb: null` was hardcoded on draft rows, on Shopify
mismatch rows and on the failed-run row, so Tracking rendered an empty grey square for every
product — the rows an operator is most likely to be triaging, since a draft is the unit of
work they actually recognise.

A draft's cover is **image position 1** — the operator's own order, and the one Shopify shows
first. Mismatch rows resolve through the same map; their drafts are *published*, so they are
not in the draft query and their ids are collected separately.

**Purged versions never produce a URL.** Retention deletes the R2 object seven days after
publish and deliberately keeps the row for the audit trail (D5), so `thumb_key` still reads
fine and still presigns fine — and then 404s in the browser. That would surface a week after
the work, on published products only. A blank square is honest; a broken image looks like a
bug in the console. The rule now also covers intake rows, which had the same latent hole.

The two selection rules were pulled into `src/lib/tracking/thumbs.ts` purely so they could be
tested — the read model is `server-only` and cannot be imported from vitest.

**Rejected:** falling through to image 2 when the cover is purged. Two different products
would then show the same photograph and look like a duplicate.

---

### D68 — Four photographs per tick, in parallel; finished failures leave /Raw

*Business decision, 2026-08-01, after the owner asked why concurrency would cost more.*

**It does not, and the earlier claim was wrong.** A photograph costs $0.0756 (measured:
$0.005992 describe + $0.069611 image). Four hundred of them cost ~$30 whether that takes
twenty minutes or three hours. Concurrency changes the rate at which a fixed cost is paid,
not the price. The only thing it genuinely changes is how much an *unnoticed* mistake
accumulates before a human looks: ~$9/hour becomes ~$36/hour. That is an argument for an
aggregate spend cap, which is still **not built**, and it was not a reason to withhold the
throughput the business asked for.

**Parallel, not a bigger sequential batch.** Four sequential calls at ~65 s overrun the
240 s budget and the 300 s Vercel limit, so the fourth would never run. Parallel finishes in
`max(4)` rather than `sum(4)`, which also makes it *less* likely to be killed mid-call than
raising the sequential batch — and a kill after the paid request is the one path that can pay
twice.

Claims are still taken one at a time: each is a single atomic `UPDATE … RETURNING` that takes
the row lock, so concurrent claims would serialise on the database anyway. Only the slow part
runs in parallel.

`Promise.allSettled`, not `all`. `processClaim` rethrows when *this* worker has lost its lease
to a replacement — a fact about one photograph. Rejecting the batch would discard three
siblings' finished work from the result while their rows sit correctly written in the
database. The count surfaces as `stale`.

The cost: a killed tick now strands four leases instead of one. The 900 s lease and the
five-minute sweeper already handle that; it is fifteen minutes of delay, not lost work.

**Discovery nudges enhancement.** Both jobs already run every minute, so this only removes the
gap between them — up to a minute of dead time on the first photograph, which is the entire
wait when someone drops in a single test image. Fire-and-forget, two-second abort, exactly the
pg_net pattern. `CRON_BASE_URL` was **missing from Vercel production**, so the first version
of this would have silently done nothing for ever while every test passed; the variable is now
set and the nudge returns its reason instead of a bare boolean.

**Terminal failures leave /Raw for /Discarded.** Only `failed` and `cost_ceiling_failed` move.
`retry_scheduled` must not: the photograph is coming back, and a file in /Discarded would tell
whoever is watching the folder that Loupe had given up on queued work. Drive file ids are
stable across moves and the worker downloads by id, so Retry from Tracking still works.

**This is not a spending guard, and must not be sold as one.** Re-scanning /Raw has never
re-enqueued anything — `drive_file_id` is UNIQUE, so a file left in place is read and skipped
(hard rule 3). It keeps the folder honest for the human looking at it, which is a smaller and
different claim than preventing runaway spend.

---

### D69 — Three confirmed malformed live SKUs are excluded from counter seeding

*Business decision, 2026-08-01, confirmed for the live-store cutover.*

The live catalogue contains three numeric-looking SKU typos whose product titles prove the
intended sequence numbers:

- `NK7801` is Necklace 801 and means `NK801`;
- `BK3367` is Bracelet Kada 337 and means `BK337`;
- `AK0834` is Anklets 084 and means `AK084`.

They are valid under the generic `<letters><digits>` parser, so merely taking the largest
parsed number would permanently raise the monotone counters to 7801, 3367 and 834. They are
therefore excluded **before** maxima are calculated. The dry-run report and the audit event
still list every excluded row and its confirmed correction; discarding them from the counter
calculation does not mean hiding them or deleting the products from Shopify.

The exclusion is an exact allowlist of these three SKU strings, never a numeric heuristic.
A future unusually large SKU may be genuine, and silently treating it as a typo would be the
same class of irreversible catalogue error in the other direction. Adding another exclusion
requires the product title or another business-owned source proving the intended number.

---

### D70 — Stock belongs to the customer choice; trays use a `Number` option

*Business request, 2026-08-03.*

The old draft had one `stock` integer and copied it onto every colour variant. That cannot
represent either of the two real catalogue cases: Gold and Silver having different
quantities, or one tray photograph containing thirty labelled rings with different
quantities. `product_draft_variants` now stores the customer-facing option value and its
own non-negative stock.

A product has exactly one option mode:

| mode | Shopify option | inventory source |
|---|---|---|
| `none` | `Title / Default Title` | `product_drafts.stock` |
| `colour` | `Colour` | one row per normalised colour |
| `number` | `Number` | canonical values `1..N`, one row per photographed label |
| `size` | `Size` | one row per trimmed ring-size label |

Colour, Number, and Size are alternatives, not a cross-product. A tray number identifies the exact
piece visible in the photograph; adding a second colour dimension would invent combinations
that are not physically present. If the business later photographs genuine colour × number
combinations, that is a separate two-option design rather than something this schema should
guess today. Numbered trays are capped at 100 choices in Loupe (the reported case is 30).

Every option variant keeps the parent SKU. That preserves the verified live-store convention
(`AK011` on Gold and Silver) and extends it to numbered and size choices; Shopify permits shared SKUs.
Publishing and the zero-stock guard sum the authoritative option rows, while the actual
Shopify mutation sends each row's exact stock to the primary location. Reconciliation still
does not compare live inventory because sales legitimately change it (D54).

`product_drafts.stock` deliberately remains for simple products and for rolling-deploy
compatibility with the old console. When options exist it mirrors the largest row, not the
sum: the old screen interprets that field as “stock per colour,” so storing the sum would
double it on every save. A trigger keeps the mirror stable; new code never uses it to publish
option inventory.

The migration keeps one defaulted `p_colours` compatibility input on
`save_product_draft()` rather than leaving a second overload. The old deployed bundle can
continue saving during rollout, but new saves send `variant_kind` plus structured rows.
Colour usage ranking ignores every non-colour row because numbers and sizes are not colour
vocabulary to suggest on the next product.

---

### D71 — Catalogue-ready manual uploads bypass both AI calls

*Business request, 2026-08-03.*

A photographer may already have a finished JPEG, PNG or WebP that should enter the normal
Pending/product-draft flow without first going through Drive `/RAW`, description generation,
or image enhancement. The browser uploads that file directly to one private R2 object using a
15-minute signed PUT URL. A durable `manual_uploads` row ties the URL to its authenticated
operator and lets completion be safely retried.

Completion does not trust the browser's metadata. The server reads the private object back,
checks its exact byte count, decodes it, verifies the declared format, reads its oriented
dimensions, and derives only a thumbnail and perceptual hash. One transaction then creates an
`intake_files` row with `source = 'manual'` and status `enhanced`, plus one selected
`image_versions` row whose storage key is the untouched uploaded original. No prompt, model,
or AI cost is involved. Manual rows are excluded from Drive housekeeping. D74 later permits a
deliberate image-only AI redo from the immutable R2 original; its synthetic `manual:<uuid>`
identity is never sent to Drive.

Direct browser upload is deliberate: sending a full-resolution photograph through a server
action would be subject to the deployment platform's request-body ceiling. The R2 bucket stays
private. Its CORS configuration allows only `PUT`/`HEAD` from the exact console origin and
still requires the signed URL; it is not public read or public write access.

---

### D72 — Deleting a Shopify draft retires its SKU; it never reallocates it

*Business clarification, 2026-08-03; reinforces D2 and D60.*

> **Superseded by D81 (2026-08-04).** The SKU still remains retired, but full and daily
> reconciliation now delete the Loupe draft instead of allowing Save draft to recreate it.

Once Save draft reserves an SKU and handle from the draft's category sequence, both remain
frozen on that Loupe draft. If somebody deletes the corresponding Shopify DRAFT product,
the next Save draft addresses `productSet` by the same handle, recreates the product with the
same retired SKU, and replaces Loupe's stale Shopify product id with the newly returned id.
The number is not put back into the category sequence. A gap is harmless; reusing a number can
create two physical products with one SKU when requests overlap or a deleted item is restored.

Loupe therefore does not query Shopify for `max(SKU) + 1` during Save draft or Publish.
Shopify permits duplicate SKUs, multiple publishes can be in flight, and deleted/draft products
make a catalogue maximum an unsafe allocator. Per-category accuracy comes from the category's
confirmed prefix plus the atomic Postgres counter. If products are created outside Loupe, the
explicit `seed:counters` reconciliation may raise each counter to Shopify's verified maximum
during a quiet operational window; it never lowers a counter and is not part of the publish
transaction.

---

### D71 — Colour choices are selected and previewed as swatches

*Business request, 2026-08-03.*

The customer choice remains a normalised human name (`Gold`, `Silver`, `Rose Gold`) because
that is the stable Shopify option value and the only useful audit label. The console no
longer presents those names as its primary visual control: it merges category-ranked
remembered colours with a fixed jewellery palette and renders circular swatches in both the
picker and the image preview. Each selected swatch keeps its independent stock input.

Metal finishes use deliberately distinct treatments rather than flat yellow/grey/pink.
Simple combined names such as `Red / White` render as split swatches. Unknown remembered
vocabulary uses a neutral custom marker; hashing an unknown name into a random hue was
rejected because it would look authoritative while potentially showing the wrong colour.

The name is still exposed through labels and hover text for accessibility. D75 supersedes the
original publish boundary by adding Shopify-native saved colours and explicit permissions.

---

### D73 — Ring size is a fourth single-option stock mode

*Business request, 2026-08-03.*

Some rings are one design sold in multiple sizes, and inventory belongs to the exact size.
Loupe therefore adds `size` beside `none`, `colour`, and `number`. It publishes one Shopify
option named exactly `Size`; every option value is a separate tracked Shopify variant with
its own stock at the primary location and the same parent SKU.

The console offers numeric sizes 4 through 30 for quick entry, but storage is deliberately
not a numeric-only column. Ring sizing systems differ, half sizes are real, and the catalogue
may use labels such as `US 7` or `Adjustable`. Values are trimmed, internal whitespace is
collapsed, and duplicates are refused case-insensitively. A product still chooses exactly
one option dimension: this change does not create colour × size combinations.

The deployed save RPC keeps its existing signature for rolling compatibility. The database
check and guarded function definition now accept/persist size rows; the legacy parent stock
continues mirroring the largest option row, while publishing and validation use the
authoritative per-size rows.

---

### D74 — Every selected image is reviewable; manual AI is opt-in; console deletion stops at Shopify

*Business request, 2026-08-03; extends D52, D64 and D71.*

The product editor renders every selected photograph at review size in Shopify publish order,
one below the next in its existing vertical scroll. The compact image list still controls
selection, version choice and ordering; it is no longer the only way to inspect images beyond
the first one.

A catalogue-ready manual upload still bypasses both AI calls on intake. The operator may later
choose **Run AI enhancement**, which uses the existing durable image-only redo, including prompt
review and an unselected generated version that must be accepted deliberately. It does not call
the descriptor retroactively: missing description is settled and the existing flat-curve
presentation fallback is recorded so the image job can run from the immutable R2 original.
Re-queuing the ordinary intake worker was rejected because that worker downloads by Drive id and
manual uploads deliberately have only a synthetic `manual:<uuid>` identity.

Delete is available only while a photograph is ungrouped in the Pending console. A database claim
atomically moves it to hold before external cleanup, so grouping and deletion cannot both win. A
Drive source moves to `/Discarded`, then its R2 objects and database row are removed; a manual
source skips Drive and removes R2 before its database row. Current product members, published
rows, and any photograph ever attached to a draft already sent to Shopify are refused in the
database, even if a stale browser tries to call the action. From that point onward, deletion is a
Shopify catalogue operation. A completed manual-upload handshake cascades only when its intake is
intentionally deleted; the durable event audit remains.

---

### D75 — Colour variants use Shopify Color default entries and may own one image

*Business request, 2026-08-03; supersedes the Shopify publishing boundary in D71.*

Loupe publishes the option with Shopify's exact native name `Color`, not the British `Colour`
label used internally. Each selected value links through the standard `shopify.color-pattern`
category metafield to the `shopify--color-pattern` metaobject Shopify materialises when a merchant
selects a Color **Default entry** in Admin. Existing merchant entries win; Loupe creates a missing
record only for a known solid palette colour with a deterministic handle, hex swatch, and standard
taxonomy colour id. It refuses to invent a native record for an unknown, split, patterned, or
multi-colour label because that would turn a visual guess into durable store-wide data. The app
must have `read_metaobjects` and `write_metaobjects` as well as its existing product and inventory
scopes. Shopify does not expose this category-owned definition through
`standardMetaobjectDefinitionEnable`; a new store activates it once by adding Color to any
categorized draft product, selecting one value under Default entries, and saving. Loupe reports
that exact one-time setup instead of trying an unrelated standard-definition mutation.

Every selected image remains ordinary product media unless the operator optionally assigns it to
a colour. The draft stores that relationship, publishing includes the same file in product media
and as the matching variant's featured file, and at most one image may target each colour because
Shopify exposes one featured media reference per variant. Moving the assignment is preferable to
silently accepting two competing featured images. Switching the draft away from colour mode or
removing a selected colour clears the now-invalid image relationship.

---

### D76 — Shopify Color retries repeat the linked metafield and never reuse failed media

*Production acceptance finding, 2026-08-03; operational detail for D47 and D75.*

Shopify accepts a new `productSet` with a native Color option, but its update path returns a
`CAPABILITY_VIOLATION` when the same request also writes another product metafield unless the
`shopify.color-pattern` list is repeated in `input.metafields`. Loupe therefore sends the same
ordered metaobject ids both in the option's `linkedMetafield.values` and as a
`list.metaobject_reference` product metafield. Each variant still selects one id through
`linkedMetafieldValue`. This duplication mirrors Shopify's current Admin API contract; removing
it makes the first Save-draft retry fail even though product creation works.

Shopify also retains a MediaImage id when fetching `originalSource` ends in HTTP 404. That id is
queryable but cannot be associated with a product again. Crash recovery may reuse media in
`PROCESSING`, `UPLOADED`, or `READY`, but must treat `FAILED` as absent and send a fresh source.
The post-write readback similarly records only non-failed ids. This preserves D47's no-duplicate
retry behavior without trapping a draft on an unusable Shopify file.

---

### D77 — Manual full reconciliation may raise future SKU counters, never renumber history

*Business request, 2026-08-04; extends D2, D54 and D72.*

Tracking exposes one prominent, authenticated **Full reconciliation** control. After an explicit
confirmation it performs the operational checks an owner expects from a manual full run:

1. Shopify-backed Loupe drafts are checked by their reserved handle. A Shopify `ACTIVE` product
   promotes the Loupe draft through the normal publish transaction. A missing Shopify draft is
   reported, but the Loupe draft and its SKU remain reserved; saving that draft recreates the same
   handle and identity.
2. Every published Loupe product is compared with Shopify through the existing durable,
   single-leased reconciliation. Catalogue drift—including SKU differences and deleted published
   products—is reported and never silently overwritten.
3. Every Shopify variant SKU is scanned for known category prefixes. The three confirmed malformed
   live SKUs from D69 are excluded exactly, unknown prefixes and unparseable values are reported,
   and `raise_sku_counter()` is called only where Shopify's maximum exceeds Loupe's counter.

The third step corrects **future allocation**, not existing product history. The database write is
`greatest(current, observed_max)`, so overlapping runs are safe and a deleted product, stale scan,
or lower Shopify maximum can never move a counter backward or make an old SKU reusable. Existing
wrong SKUs remain visible reconciliation issues requiring a deliberate product-specific repair.
The control states this boundary before it runs and records the counter scan in the event audit.

---

### D78 — Native Color product updates omit `productSet.metafields`

*Production failure and acceptance, 2026-08-04; supersedes the linked-metafield workaround in
D76 while preserving its failed-media rule.*

Shopify owns `shopify.color-pattern` once that metafield is connected to the product's native
`Color` option. The option must be changed through `productOptions.linkedMetafield.values`, and
each variant selects its entry through `linkedMetafieldValue`.

`productSet.metafields` is a declarative list, which creates two distinct failures on a native
Color product:

- including only `custom.material` asks Shopify to remove the omitted connected colour metafield
  and returns `CAPABILITY_VIOLATION`;
- repeating the connected colour metafield lets an unchanged retry pass, but adding or removing a
  colour asks Shopify to edit the option-owned metafield directly and returns "To make changes,
  edit the option."

Loupe therefore omits `productSet.metafields` entirely whenever the option is native Color. After
the product/options/variants mutation succeeds, it synchronises the unrelated `custom.material`
metafield with `metafieldsSet`, or removes it with `metafieldsDelete` when an unfinished draft has
no material. This is intentionally a two-call write. If the second call fails, the draft is marked
failed while retaining its handle; the normal retry converges on the same Shopify product and does
not create a duplicate.

---

### D79 — Native saved-colour matching normalises British and Shopify spellings

*Production failure and acceptance, 2026-08-04; narrows D75's existing-entry rule.*

Loupe may display British jewellery vocabulary such as `Multi Colour`, while Shopify's taxonomy
owns the American label `Multicolor`. Saved native Color entries are matched through a canonical
comparison that treats `colour` and `color` as equivalent and ignores spacing and punctuation.
The product variant still receives Shopify's native display label because the linked metaobject is
the source of truth.

This is identity matching, not swatch generation. Loupe reuses the merchant's existing metaobject,
including its richer image/pattern data, and continues to refuse an unknown multi-colour value
rather than manufacture a misleading solid swatch.

### D80 — Enhancement gets exactly three short retries, then shows the error

*Operator decision, 2026-08-04; supersedes the retry counts/delays in D29 and D39.*

An initial description or image attempt receives exactly three automatic retries: after 1 minute,
2 minutes and 5 minutes. If the fourth total attempt fails, the intake row becomes `failed`, its
lease is released, and the last provider/validation error remains visible in Tracking for a human
decision. Manual image-redo jobs use the same retry budget. Permanent errors still fail on their
first attempt, and a redo whose paid generation may already have started still fails rather than
risk charging for a duplicate request.

Description exhaustion no longer silently assigns `flat-curve` and proceeds to image generation.
That behavior hid the real outage and made queued work look inexplicable. A completed description
response that exceeds its configured cost ceiling remains the narrow exception: it already
incurred the cost, so Loupe records the deliberate no-description fallback and moves to the image
stage instead of paying for the same over-budget call again.

When this policy was deployed, existing queued attempt-2 and attempt-3 deadlines were shortened to
their new failure-relative deadlines. Waiting rows at attempt 4 or later were made visibly failed.
No deadline was extended, and every automatic reschedule/failure was written to the event audit.

---

### D81 — Shopify deletion removes the corresponding Loupe draft

*Business direction, 2026-08-04; supersedes D72's recreation behavior and D77 point 1's
missing-draft warning.*

Once a Loupe draft has been saved to Shopify, Shopify is authoritative for whether that product
draft still exists. The daily and manual full reconciliation read the reserved handle. If Shopify
returns no product, Loupe deletes the matching unpublished `product_drafts` row instead of keeping
an editor that can recreate it. Its grouped source photographs are preserved and returned to
Pending; deleting a Shopify product is not permission to destroy the source files or generated
versions.

The SKU remains permanently retired. Deleting the row never lowers the per-category counter, so a
new product receives the next number rather than reusing the deleted identity.

Deletion is a fenced database operation. It compares the exact recorded Shopify product id and
refuses a draft with a live Save/Publish lease, a changed id, or `published` status. This prevents
a stale reconciliation read from deleting a draft that was concurrently recreated or from
orphaning an in-flight Shopify write. Published products continue through normal catalogue drift
reporting and are never silently deleted from Loupe.

---

### D82 — Prompt drafts preserve edits; model copies preserve preset identity

*Operator-reported prompt failure, 2026-08-04; extends D51, D65 and D66.*

Creating an image-prompt version remains structurally guarded because an unusable live template
would stop every enhancement. The form no longer redirects after submission: validation feedback
stays beside the editor and the operator's name, prompt body and model remain intact. A normal
pasted image prompt with no `{{PRODUCT_DESCRIPTION}}` token is not refused; Loupe prepends its
canonical PRODUCT block and says that it did so. Duplicate or ambiguous template tokens are still
rejected rather than silently rewritten.

Model selection is an immutable prompt copy, so it must carry all behavior-defining fields—not
only name/body/kind. `select_prompt_model()` now copies `uses_composition` and `preset_slug`.
Without the former, changing the model of the hand-chain or bag preset makes the live body and
composition flag contradict each other; without the latter, the picker says “Use this preset” for
the preset that is already active. The production pair lost its D66 `satin` tags through the old
copy path; the migration restores them only because both live bodies match the same complete
preset.

---

### D83 — Authenticated screens follow the event audit for live updates

*Operator experience decision, 2026-08-04; supersedes D61's assumption that a Console-only
counter poll is sufficient to keep cached screens current.*

Every authenticated screen mounts one compact server-authorised heartbeat. It reads the latest
monotonic `events.id` plus queued and actively enhancing counts every four seconds while the tab is
visible, and immediately when a hidden tab becomes visible again. The per-tab cursor is retained
across Loupe navigation, so Console, Drafts, Tracking and Prompts share the same stream rather than
each creating an unrelated poll.

The event cursor is the change signal. Current totals alone are not: a photograph can be claimed
and enhanced between two polls and leave the same total at both ends. A meaningful audit event
refreshes the affected screen; intermediate description/image-storage events do not trigger a
costly image-signed read. Existing valid thumbnail URLs are preserved across those state refreshes
to avoid a download storm.

Queued or enhancing work stays visible in a global activity capsule below the shared navigation.
New arrivals, ready photographs and failures produce short global notifications; only failures use
amber because amber still means a human is needed. Tracking now refreshes its rows automatically,
and Console refreshes its grid when a transition can add, remove or change a tile.

The browser does not subscribe to Supabase directly. RLS intentionally gives it zero table access
(D11), and weakening that boundary for convenience would make the publishable key a second data
API. The heartbeat is a server action that re-authorises every call and returns counts plus safe
event names/ids only—no event detail, image keys or secrets.

---

### D84 — Enhancement is a source-authoritative edit, never an aspirational redesign

*Six-product failure review and production probe, 2026-08-04; supersedes D56's 60–100-word
descriptor contract and D51's accepted prompt/model pair.*

The default descriptor is `openai/gpt-5.6-sol`; the default image editor is
`openai/gpt-image-2`. GPT Image 2 is the production default recommended by OpenAI for
identity-sensitive edits and workflows where fewer retries matter. The image prompt follows its
surgical-edit pattern: say exactly what may change, enumerate what must remain invariant, and make
the supplied reference the final authority if text and pixels ever disagree.

Product identity is not adequately represented by generic catalogue prose. The descriptor must
record exact visible counts for discrete design elements, strands and fittings; chain topology;
side-specific component order; attachment and setting type; hardware count; silhouette, relief,
spacing and asymmetry. Ordinary chain links and continuous pavé are not fabricated counts. An
unclear detail stays explicitly unclear. This replaces the old instruction that prohibited exact
component counts—the instruction directly responsible for losing information before generation.

Catalogue styling is subordinate. Satin, marble, yellow, hand-chain and bag prompts may change the
surroundings, permitted pose, lighting and light cleanup, but may not "upgrade" the product. A loose
jump-ring charm cannot become a prong-set stone; a solid motif cannot become a gem or disappear;
chains cannot thicken or change construction; extenders cannot duplicate; asymmetric spacing cannot
be regularised; engraved or sculptural pendants cannot be simplified. The PRODUCT record aids
inspection; the source image wins every conflict.

The common 1200×1600 raw photo is no longer downscaled to 768×1024 before either model sees it.
Model inputs retain their original resolution up to a 2048px long edge and use high-quality 4:4:4
JPEG encoding. GPT Image 2 already applies high input fidelity by default, so Loupe sends no obsolete
`input_fidelity` parameter. Output remains 1280×1280 at medium quality under the independent $0.20
image ceiling.

Six live descriptor probes cost $0.0300–$0.0366 each and recovered all six reported products'
counts and topology. `MAX_COST_USD_PER_DESCRIPTION` is therefore $0.05; leaving it at $0.02 would
discard the good Sol response and silently send the image stage no PRODUCT record. All five saved
presets use the same model pair and maintained identity contract, and preset promotion selects the
newest reviewed revision rather than the oldest historical body.

---

### D85 — Console category creation establishes a complete, immutable SKU sequence

*Business request, 2026-08-04; extends D1, D2, D23 and D75.*

An authenticated console operator may create a new product category from the category picker. The
flow requires the customer-facing name, 2–4 permanent SKU letters, title wording, exact Shopify
collection tag and a leaf Shopify product-taxonomy category. Taxonomy choices come from Shopify's
live taxonomy search and the chosen id is read back from Shopify on the server before it is stored.
Loupe may suggest initials and singular title wording for convenience, but the operator explicitly
confirms every naming field; the database never guesses or silently creates a tag.

`create_console_category()` inserts the active category, a zeroed `sku_counters` row and the audit
event in one database transaction. Creating a category allocates no product number. The first Save
draft or Publish still calls the existing atomic counter and receives 001; an existing category
name or prefix is refused because an SKU sequence cannot be repurposed.

Waist Chains is the first business-established category with no historical Shopify products or
collection to reconcile: prefix `WC`, title pattern `Waist Chain {n}`, exact tag `Waist Chain`, and
Shopify taxonomy `Body Jewelry`. Its counter starts at 0, so the first product preview is `WC001 ·
Waist Chain 001`. Reading Shopify's maximum at publish time, automatically accepting the first
taxonomy search result, and creating category/counter rows in separate requests were rejected.

---

### D86 — A provider quota refusal pauses the queue; it never fails a photograph

*Discovered live on 2026-08-05 while running paid prompt evaluations.*

OpenRouter answers HTTP `402` when the account balance falls below the reserve it holds *before*
starting a request — not only when the balance reaches zero. Measured against `openai/gpt-image-2`:
$0.739737 was accepted, $0.662771 was refused, and neither a 12-word prompt nor `quality: low`
lowered the floor. Chat completions kept succeeding at the same balance, so the describer stays
healthy while every image call fails, and the dashboard still shows positive credit.

Loupe classified `402` as permanent, because `retryable` was true only for `408`, `429` and `5xx`.
A permanent error skips the retry budget and fails immediately (hard rule 4), so a queue running
out of credit would drain into `failed` at up to four photographs per tick, each showing the
operator **"The image model rejected this photograph."** Nothing pointed at billing, and recovery
meant a manual retry sweep across every drained row.

A quota refusal is a fact about the *account*, not the photograph: the same file succeeds unchanged
once credit is restored. So the worker now **abandons its claim** rather than recording an attempt.
`claim_next_intake_file` deliberately does not increment `attempts`, so an abandoned lease expires
and `sweep_expired_intake_leases` returns the row to `discovered` exactly as it was. No `failed`
rows, no retry budget spent, no Drive housekeeping — `terminalFailures` is an allowlist of `failed`
and `cost_ceiling_failed`, so paused work correctly stays in `/Raw`.

`EnhancementError` carries a `quota` flag rather than a matched code string, and the batch reports
`providerQuotaPaused` with one `enhancement.paused_provider_quota` system event per tick — not per
photograph, because the condition belongs to the account.

Rejected: keeping it retryable on the normal 1m/2m/5m schedule (it still fails the file permanently
after ~8 minutes, for a condition a top-up fixes); and a per-tick circuit breaker strong enough to
stop siblings mid-flight (claims run concurrently under `Promise.allSettled`, so a breaker only
spares a claim that has not yet reached its provider call — acceptable, because a `402` is refused
before generation and bills nothing).

**Still open:** `/tracking` does not yet surface the pause. The event is durable and queryable, but
an operator currently sees only work quietly not progressing.

---

### D87 — Kimi K3 is the describer, and reasoning effort is a tunable again

*Isolated candidate evaluation and a live end-to-end call, 2026-08-05. Supersedes D84's
`openai/gpt-5.6-sol` describer default and the hard `minimal` reasoning lock.*

`scripts/evaluate-description-models.ts` over the five Phase 3C acceptance sources, zero
production writes:

```
candidate                      strict JSON  class  cost/image
qwen/qwen3.7-flash                    0/5      —   $0.00025          (empty result every time)
google/gemini-3.5-flash-lite          4/5    5/5   $0.001
moonshotai/kimi-k2.6                  0/5      —   $0.0065-0.0091    (empty result every time)
moonshotai/kimi-k3                    5/5    5/5   $0.0108-0.0217
```

`kimi-k3` was the only candidate that returned strict valid JSON on every source. The two
cheapest options are not cheap in practice: Qwen Flash returns nothing at all, and K2.6 also
returns nothing while still billing more than Gemini, because it spends the budget reasoning
and never emits. Against Sol's observed production range of $0.021612–$0.053134, K3 is roughly
half the cost — and Sol had just breached the live $0.05 ceiling on a real photograph,
discarding a paid description and leaving that product with no identity record.

A live call through the production path afterwards: `$0.014358`, 18.0 s, `necklace-station`,
170 words, and factually correct on a seven-station necklace — "four being solid polished
gold-tone flat rectangles and three being clear faceted rectangular baguette-cut stones",
which matches the source exactly.

The harness's expected class for `phase3b-01.png` was corrected in the same change. It said
`flat-curve`, written before 20260804193000 added the four `necklace-*` classes; K3 and Gemini
independently answered `necklace-station`, which is what the live describer prompt actually
defines. Both models were right and the fixture was stale.

**Reasoning effort is no longer hard-locked.** `DESCRIBE_REASONING_EFFORT` accepts `minimal`,
`low`, `medium` and `high`; an unrecognised value still fails loudly. The lock existed only to
cap reasoning spend at Sol's $5/$30 per 1M, and `MAX_COST_USD_PER_DESCRIPTION` was always the
real guard — it fails safe by refusing the result rather than overspending. The **default stays
`minimal`**, so raising it is a deliberate experiment and never happens by upgrading.
`max_completion_tokens` now scales with effort (1.5k/3k/6k/12k): reasoning tokens are excluded
from the response but still counted against that budget, so a fixed 1,500 would have truncated
the JSON mid-object the moment effort rose.

The curated allow-list is enforced twice on purpose — `src/lib/prompts/models.ts` for the
console selector and `prompts_model_is_curated` in Postgres so nothing reaches the table another
way. Both moved together in `20260805150000`.

**Not yet proven:** the comparable five-product *image* run CLAUDE.md requires before a
describer change counts as accepted. The owner selected this model explicitly and is running
that acceptance themselves. Phase 3C's `< $0.006` cost gate is still not met — $0.0108–$0.0217
is above it — but the owner's stated target is $0.02–$0.03, which K3 meets.

---

### D88 — Long chains get their own self-staging presets, because scale is not recoverable from an isolated square

Reported 2026-08-08: necklaces and waist chains enhanced through the satin and marble presets
come out looking like bracelets or anklets. Those presets remain good for rings, earrings and
everything else, so the fix is a new preset per long-chain category rather than an edit to the
shared art direction.

D1 already recorded the underlying fact from the other side: *"an anklet and a chain bracelet are
the same object at different lengths and cannot be told apart from a photograph."* The generation
stage has exactly that problem in reverse. A closed gold loop on satin, cropped to fill a square,
carries no scale reference at all; a 45 cm necklace and an 18 cm bracelet posed that way are the
same picture. The shared prompt then pushes actively toward the shorter reading in four places:

* `CAMERA AND CROP` — "Arrange flexible length compactly so the focal design is large" plus
  "Fill roughly 82-92% of the useful square". Compact-plus-fill is scale-blind.
* `ART DIRECTION` — rules out a "stretched display of length", penalising the one cue that says
  the piece is long.
* `necklace-pendant` asks for a "compact, graceful oval … rather than a long narrow measuring
  loop"; `necklace-station` asks for a "broad closed oval".
* Nothing states the real worn length anywhere.

Waist chains have a fifth and sharper problem: there is no waist-chain presentation class, and the
nearest by wording is `flat-arc` — *"Lay the same flexible bracelet or anklet in a relaxed compact
arc."* A waist chain classified `flat-arc` is being instructed to pose as an anklet.

**Decided:** two new presets, `necklace` and `waist-chain`, in `20260808120000`. Every block
already visually accepted (SOURCE AUTHORITY, FORM AND SCALE LOCK, LIGHTING, COMMERCIAL RETOUCHING,
OUTPUT) is copied byte for byte from the accepted satin hero so the look does not drift. Four
blocks are new or rewritten: a `TRUE LENGTH` scale contract naming the real worn length and the
proportions that carry it; an inverted crop rule putting the negative space *inside* the loop
rather than around it; an explicit POSE block; and a background chosen not to compete with a piece
that crosses the whole frame.

The scale contract is the load-bearing part, and it is written as proportions rather than as a
measurement, because the model cannot render centimetres but can render *many fine links around a
wide open centre*. Coarsening the chain — fewer, fatter links to fill the frame — is named
explicitly as the single change that shortens a piece.

**Both are `uses_composition = false`**, joining hand-chain and bag. The audited composition
classes stage a piece lying compactly on a surface, which is precisely the instruction these
presets exist to overrule; injecting one would send the image model two contradictory poses. The
consequence is that the POSE block must cover pendant, station, multistrand and lariat itself, and
that is most of why these bodies run ~1270 and ~1350 words against the house 774-830.

**Rejected — editing the shared composition classes in `presentation.ts`.** That would change
satin, marble and yellow for every necklace at once, including the ones the owner is happy with,
and it cannot express a waist chain at all without a new enum value and a migration on
`presentation_class`.

**Rejected for now — staging the piece on a neck form or a worn model.** It is the surest fix,
because it supplies the absolute scale reference a flat-lay cannot, and hand-chain is the existing
precedent for a worn preset. It was not taken because the rest of the catalogue is flat-lay and a
bust changes the storefront's visual language. Revisit if the flat-lay scale contract proves
insufficient in the acceptance run.

**Not yet proven:** no image has been generated from either preset. Both are inserted non-current
and archived; nothing is promoted. Acceptance is a five-source image run per preset, checking that
the output cannot pass for a bracelet or anklet, that component counts and chain construction
still match the source, and — for waist chain specifically — that a doubled drape never renders
as two separate chains.

---

### D89 — Publish sets the sales channels itself, on every publish, to every active APP catalog

Reported 2026-08-08: every product published from the console lands on **no** sales channel, and
somebody has to open Shopify admin and tick Online Store, Point of Sale and Google & YouTube by
hand, one product at a time.

**Cause, introspected against the live store on API 2026-07:** `ProductSetInput` has no
publications field. Its full input list is `descriptionHtml handle seo productType tags
templateSuffix giftCardTemplateSuffix title vendor category giftCard redirectNewHandle status
collections metafields files productOptions variants requiresSellingPlan claimOwnership
combinedListingRole`. `productSet` therefore *cannot* publish to a channel, whatever it is passed.
Nothing was auto-covering the gap either: `autoPublish` is `false` on all four publications on
`qimti`, and all 2,816 products confirm the pattern — every ACTIVE product is on 4/4 channels
because a person put it there, and the only products below 4/4 are ARCHIVED.

**Decided:** `src/lib/shopify/publications.ts`. After `productSet` returns, `publishProduct` calls
`publishablePublish(id, [PublicationInput!])` with every publication whose catalog is an **APP**
catalog with status ACTIVE.

*Every* APP catalog, with no allowlist of channel names. A channel Qimati installs later is a
channel they want their products on; an allowlist would silently omit it and reintroduce the manual
step this removes. MARKET and COMPANY_LOCATION catalogs are excluded — those are Markets and B2B
price lists, and publishing to them is a different commercial decision.

**It runs on the Shopify DRAFT path too** (D60). Shopify's DRAFT status hides a product from buyers
regardless of publication, so setting channels early is invisible, and it means the later Publish
makes the product live everywhere at once with nothing left to remember.

**A failure here is fatal, not best-effort.** It throws, and the existing catch marks the draft
`failed` while keeping its handle — the same trade the media-id write already makes. That is safe
because both halves of the retry are idempotent: `productSet` updates the same product by handle,
and `publishablePublish` is a no-op for a publication the resource already has. Swallowing the
error would produce a draft that reports "published" while reaching no buyer, which is the exact
failure being fixed.

**An empty channel list is not an error.** A store with no active sales channel is one nobody has
finished setting up; blocking a publish over it would stop the operator for a reason they cannot
act on from the console. The console shows an attention notice instead.

**Rejected — `Publication.autoPublish`.** Turning it on in Shopify would cover products created by
any source, but it is store configuration rather than something Loupe controls or can assert, it
is per-publication and easy to miss on a newly installed channel, and it leaves no audit trail. The
explicit call records exactly which channels each product reached.

**Rejected — a `Publication.name` lookup.** That field is deprecated. Channel names come from
`catalog { ... on AppCatalog { apps(first: 1) { nodes { title } } } }`, falling back to the
publication id so a nameless channel is still published to rather than dropped for cosmetics.

**Scopes:** none needed. `read_publications` and `write_publications` are already granted —
confirmed via `currentAppInstallation { accessScopes { handle } }`.

**Not covered:** the daily Shopify reconciliation (D54) does not yet treat a product falling off a
channel as drift. If someone unpublishes a product in admin, Loupe will not notice.

---

### D90 — Reconciliation compares what Loupe owns, not what the business edits

**The workflow this was built on was wrong.** D54 assumed Loupe publishes a product and therefore
owns it afterwards, so it diffed every field nightly. Stated by the owner on 2026-08-08:

> we will never publish products from console, our main use case of console is to draft products
> together efficiently using auto AI enhancement loop in backend, and draft products in shopify and
> publish them together during launch

So Loupe's job ends when the product exists in Shopify **as a draft**. The business then finishes
the listing in admin — correcting the material bullet, setting price, appending a title suffix like
"(ball back)", swapping photographs — and publishes the batch on launch day.

Under that workflow a field diff reports the business doing its job. The first run with real data
proved it: 53 products checked, **45 issues across 23 of them**, every one a deliberate edit, and
the same 45 would have reappeared every morning until somebody stopped reading Tracking. Hard rule
5 already says alerting that cries wolf is worse than none.

**Decided:** split by **ownership**, not by importance.

| Loupe's — still checked | The business's — no longer checked |
|---|---|
| product exists (`product_missing`) | Shopify `status` |
| Loupe recorded a product id | `title` |
| `handle` | `productType`, `tags` |
| variant SKU | `descriptionHtml`, material metafield |
| variant count and option values | price, weight |
| | media set and order |

`handle` stays because it is `productSet`'s idempotency key (hard rule 2): edited in admin, the next
save creates a second product with a duplicate SKU — the D2 failure by another road. Renaming a
product does not change its handle, so this stays quiet through ordinary launch edits.

**Variant structure stays** at the owner's explicit request — SKUs, deleted products, and changes to
colours must still be tracked. It is also where a repurposed listing surfaces: `AK089` was published
as "Anklets 089 (Single Piece)" and is now titled "Rings 229" carrying SKU `RS229`. The title is the
business's to change; an anklet number attached to a ring is not.

**Inventory quantity is still not compared.** D54 settled that and it holds harder now — it is the
one field guaranteed to move on its own once the store sells. If Qimati wants pre-launch stock
drift specifically, that is a separate, narrower decision.

**Dry run against live data before deploying:** 53 drafts, **45 issues → 5**. The five are the
AK089 SKU mismatch (3, one per variant) and a Gold colour added to Earrings 464 in admin that
Loupe's draft does not have (2). Both are real.

**Also fixed here: "Draft stalled" would have flooded next.** `record_draft_shopify_product`
deliberately returns a draft to `assembling` so the console can keep editing it, and `classifyDraft`
flagged any `assembling` draft untouched for 24 hours. Under this workflow that is *every*
correctly-drafted product, permanently. The rule now requires `shopify_product_id is null` — never
sent to Shopify, so probably forgotten. A draft that has reached Shopify reads "In Shopify" in the
`draft` group and needs nothing until launch.

**Rejected — demoting reconciliation issues to an informational group.** It would have hidden the
noise without deciding what is actually worth knowing, and the two real problems above would have
been hidden with it.

---

### D91 — Material never goes through `productSet.metafields`

`productSet` treats its metafield list as declarative, so sending only `custom.material` tries to
delete every other metafield on the product. When one of those is connected to an option, Shopify
rejects the entire mutation.

Native Color was the known case and the original fix exempted Color products only. **That was too
narrow.** Shopify links a category metafield *by itself* whenever an option name matches one the
product's taxonomy category defines — a ring published with `Size` options gets `shopify.ring-size`
linked with nothing in Loupe asking for it. Every such publish failed:

```
productSet rejected the product "rings-228": input: This metafield is connected to an option.
To make changes, edit the option. Metafield Namespace: shopify, Metafield Key: ring-size
```

**Decided:** `buildInput` never emits `metafields`, and `productSet()` always calls
`syncMaterialMetafield` afterwards.

**Rejected — an allowlist of affected option names** (`Color`, `Size`, …). There is no published
list of which category defines which option metafield and it grows as Shopify extends the taxonomy,
so the allowlist would be wrong again on the next category. Keeping material out unconditionally
removes the class rather than the instance.

The cost is one extra mutation on products that were previously exempt — which is exactly what
Color products already paid.

---

### D92 — Drive tidy-up is a sweep over state, not a step in the publish path

`tidyDriveForDraft` was only ever called from the console's publish path. Qimati does not publish
from the console (D90): reconciliation notices drafts published in Shopify admin and calls
`mark_draft_published()`, which publishes the intake rows correctly and never tidies Drive, because
nothing on that path ever did. `promote.ts` even documents the consequence in a comment and does not
act on it.

Measured 2026-08-08: **49 drive-sourced photographs at `published` with `drive_processed_at` null,
and zero `drive.housekeeping` events ever recorded.** RAW only ever grew.

**Decided:** `src/lib/console/drive-backlog.ts` — `tidyPublishedDriveBacklog()`, keyed on database
state (`status='published' and source='drive' and drive_processed_at is null`) rather than on an
event. It runs on the daily reconciliation job and on the Tracking "Full reconciliation" button,
after promotion so anything published in that same run leaves RAW immediately.

**Rejected — calling `tidyDriveForDraft` inside `promotePublishedInShopify`.** It fixes new products
and strands the existing 49 forever, because nothing revisits a draft once it is published. A sweep
is self-healing: it clears the backlog on first run, covers the promotion path, and also covers a
console publish whose own tidy-up failed. Hard rule 3 again — the DB says what is true, and
"published but never moved" is a fact readable at any time.

Bounded at 100 per run so a large backlog cannot hold a cron request open past its limit, and the
result reports `more: true` rather than implying the folder is clear. Still `published` only: a
grouped-but-unpublished photograph belongs to a draft that may still change.

---

### D93 — A dismissed reconciliation finding is a judgement, not a deleted row

Requested 2026-08-08: *"There should be option to delete some need attention task since I think they
are correct already."*

**It cannot be a delete.** `shopify_reconciliation_issues` rows are derived — every run recreates
them from scratch — so deleting one clears Tracking until 03:00 IST and then the same finding
reappears. That is worse than not offering the button.

**Decided:** `shopify_reconciliation_dismissals`, a durable record of the operator's judgement, keyed
on the finding rather than on the row that reported it:

```
(product_draft_id, code, field, actual)
```

`actual` is in the key, and that is the load-bearing part. "I accept that AK089 now carries RS229" is
a different statement from "never tell me about AK089's SKU again". If the value changes again — a
third SKU, a different colour — that is new drift and it returns. **A dismissal silences a fact,
never a subject.**

`expected` is deliberately **not** in the key: it is derived from the Loupe draft, so editing the
draft would otherwise silently revive a dismissal already made about the Shopify side.

`restore_reconciliation_dismissal()` undoes one. Both write to `events`, so a silenced finding is
still traceable to who silenced it and why. The unique index coalesces `actual` to `'null'::jsonb`
because NULL never equals NULL in a plain UNIQUE constraint and two dismissals of the same
null-valued finding would both be accepted.

A **failed reconciliation run** is not dismissible. It does not mean "this difference is fine", it
means Loupe never looked.

---

### D94 — `enqueue_image_redo` must validate a prompt against its own staging flag

20260801170000 added `uses_composition` to `validate_prompt_body` and updated
`create_prompt_version` and `promote_prompt_version` to pass it. **`enqueue_image_redo` was missed**
and kept the two-argument call, so `p_uses_composition` defaulted to `true` and every redo demanded
a `{{COMPOSITION_DETAIL}}` token from prompts that must not have one.

The gap stayed invisible for a week because the live prompt had always been satin, marble or yellow
— all composed. It became real on 2026-08-08 the moment `waist-chain` was promoted, and would have
done the same for `necklace`, `hand-chain` or `bag`. Proved against the live database:

```
BEFORE fix: REJECTED — validate_prompt_body: image prompt needs exactly one {{COMPOSITION_DETAIL}} token
AFTER fix : OK — job 34d1dce2…  (prompt=waist-chain, uses_composition=false)
```

**Decided:** `validate_current_image_prompt(prompts)` — one function that takes the whole row and
reads the flag off it. `enqueue_image_redo` calls that instead. A future caller cannot reintroduce
the mistake by copying a two-argument call, because the correct call no longer takes the flag
separately.

The migration rewrites the deployed function body with `pg_get_functiondef` + `replace`, and raises
if the string it expects to replace is absent — so a hand-edited or already-fixed function is a
loud failure rather than a silent no-op.

---

### D95 — The necklace hero is a top-cropped worn V, not the full length

D88 solved "necklaces render at bracelet scale" by showing the whole piece: a broad closed oval
filling the square with the neck opening as the largest area. It works, and it is not what Qimati
sells on.

Six reference images (`Sample-Necklace/`, reviewed 2026-08-08) all use a different shot, and the
owner asked for that one. All six share four properties:

1. the piece **hangs** under gravity — it is not lying on a surface;
2. both chain arms fall from the **top edge** and are cut off by it; clasp, extender and the top of
   the loop are out of frame in every one;
3. the arms converge into a V or shallow U with the focal element at the single lowest point,
   centred;
4. the V's depth tracks the piece — wide and shallow for a bar or cluster centrepiece, deep and
   narrow for a long station necklace.

It serves the original problem *better* than full length did: a V cut off by the top edge is
unmistakably neck-worn, where a closed loop on a surface is not. The link-gauge lock from D88 is
kept for the same reason it existed — a coarsened chain still reads as a bracelet, V or no V.

**Four decisions, taken by the owner:**

| | |
|---|---|
| Background | Clean warm ivory sweep, **no props**. The samples use ceramic sculptures, a dish rim, blurred flowers and window light; at ~300 products/month a model picking a different prop each time stops the catalogue looking like one shoot. Soft directional light and a real cast shadow do that work instead. |
| Clasp and extender | **Cropped out**, knowingly. The adjuster is information a wholesale buyer looks for and it now lives only in the description bullets. |
| Scope | **Replaces** the full-length image half. The full-length version stays in prompt history, one promote away. |
| Waist chains | Unchanged. |

Only the **image** half is replaced. The describer produces a factual identity record of the object,
which does not change with the pose, and the length-aware inspector already reports the centrepiece
and the link-to-component ratio the V needs.

**Consequence worth knowing: `promote_prompt_preset` cannot activate this.** It leaves a half that
is already live alone by design, so promoting `necklace` while `necklace` is live is a no-op and
never picks up a newer revision of the same preset. Activate it in `/prompts` with **"Promote this
version"** on the image prompt instead. Proved against the live database:

```
LIVE after "Promote this version":
  describe  Necklaces — length-aware inspector
  image     Necklaces — worn V hero   uses_composition=false, contains THE WORN V
```

---

### D96 — Selecting a preset must pick up a newer revision of that preset

`promote_prompt_preset` treated "a half of this preset is already live" as "nothing to do". That is
right when the live prompt IS the newest revision, and wrong the moment a new revision of the same
preset is added — which is exactly what editing a preset means.

**Cost of the bug, 2026-08-08:** two worn-V necklace revisions sat in the table as `ready` while the
full-length prompt stayed live and kept producing the flat closed oval it asks for. The reasonable
reading of that was "the new prompt does not work", and two rounds went into re-engineering a prompt
that had never been switched on. A control that silently does nothing is worse than one that errors.

**Decided:** compare **identity**, not existence — promote unless the live prompt is already the
newest revision of that preset. Promotion still copies rather than flipping in place, so the copy
becomes the newest revision and an immediate second call is correctly a no-op. Proved in a
rolled-back transaction: `promote('marble')` then `promote('necklace')` both return `changed: true`
and land on `Necklaces — worn V hero, hanging with ceramic backdrop`.

One trap found while writing it: `kind` is a `RETURNS TABLE` output parameter, so an **unqualified**
`kind` inside the function's `EXISTS` checks raises `column reference "kind" is ambiguous` at
runtime, not at create time. Every table reference in the function is aliased.

**Also added:** `npm run prompt:promote [slug]`. With no argument it prints every preset, its newest
revision and what is actually live, flagging `!` where the live prompt is an older revision — the
state that was invisible. With a slug it promotes, then **reads the live pair back** and exits
non-zero if a half is still stale, which catches the case where the deployed function is still the
old one. It calls the same audited SQL as the console, so the promotion is recorded in `events`
identically; it is a convenience, not a second code path.

---

### D97 — Loupe steps past hand-made Shopify numbers, and never writes over a product it did not create

Qimati lists products directly in Shopify admin, often, without the console. Loupe's counter only
learned about those during reconciliation — nightly at 03:00 IST or on a Full reconciliation click —
so anything listed by hand between scans was invisible to it.

**What happened on 2026-08-08.** `necklace-1007` was created by hand at 08:01:39. The console draft
at 08:42:42 was issued `NK1007` from a counter that still said 1006, and `productSet` — which
addresses BY HANDLE — collided with the manual product. No reconciliation ran in that 41-minute
window; by the time one did (08:46) Loupe had already taken 1007 itself, so the scan correctly found
nothing to raise. The mechanism was working; the clocks were not aligned.

Two guards, because either alone is insufficient.

**1. Step the counter past occupied numbers, before reserving.**
`src/lib/publish/shopify-numbering.ts`. Probe the candidate number in Shopify; if it is taken, raise
the counter and try the next. Runs on every publish where the draft has no reservation yet.

*Hard rule 1 is intact.* It forbids deriving a SKU from Shopify's max, because Shopify accepts
duplicate SKUs silently and any max query lies under concurrency. This does something narrower and
monotone: the counter remains the sole allocator, and Shopify is consulted only to rule candidates
out. `raise_sku_counter` cannot walk a sequence backwards.

*Probe, not scan.* `sync-sku-counters` pages every variant SKU in the store — right for a nightly
audit, far too heavy per publish. A probe is two indexed lookups in one request. Measured live: 412 ms
and one probe on the clean path; 1,503 ms and two probes stepping over the real NK1007.

*Both a SKU probe and a handle probe.* SKU alone misses a hand-made product listed with a blank SKU,
which is common, and its handle would still collide. Handle alone misses a product whose title was
edited after creation, since Shopify keeps the original handle while the SKU stays ours. Verified
that `sku:` search is exact rather than a prefix match — `sku:NK100` returns NK100, not NK1007 — so a
probe cannot skip a number by matching a longer one.

*Raise to `nextFree - 1`, not to `nextFree`.* `next_sku()` increments before returning, so the counter
must sit one below the number it should hand out. Raising to the free number itself would burn one
every time this ran.

**2. Refuse to write over a product Loupe did not create.**
`src/lib/publish/handle-ownership.ts`. Prevention that depends on a lookup a moment earlier cannot
cover somebody creating a product in the seconds in between — this makes the residual collision
harmless rather than merely rare.

Telling ours from theirs is easy when `shopify_product_id` matches. The hard case is the crash
window: `productSet` succeeded, the process died before the id was recorded, and recovering from
exactly that is a documented requirement, so this cannot simply refuse whenever the id is missing.

**The discriminator is time.** A product Loupe created FOR THIS DRAFT cannot predate the draft row —
Loupe did not know the number before then. A matching SKU is required as well but is *not* sufficient
on its own: the hand-made Necklace 1007 carried `NK1007` too, because whoever made it followed the
same convention. SKU-alone would have adopted and overwritten it. Verified against live data:

```
ownership of necklace-1007: foreign —
  "Necklace 1007" was created in Shopify before this draft existed, so Loupe did not create it
```

**Rejected — a Loupe-owned marker tag or metafield on every product.** It would identify our
products directly, but only from the moment it shipped; the 53 already published carry no marker, so
the timestamp rule would still be needed for them. Two mechanisms where one suffices.

**Rejected — checking Shopify's max inside `reserve_draft_identity`.** That SQL function cannot make
HTTP calls, and moving the reservation into TypeScript would give up the atomicity that makes
concurrent publishes safe (hard rule 1).

**Note on the existing failure.** The guards prevent the next collision; they do not repair the
`NK1007` draft, whose identity is frozen by design. That draft still needs a fresh one.

---

### D98 — Chain bracelets get their own category preset; the satin scene stays baked in

Reported 2026-08-10 against the live batch: chain bracelets out of the satin default posed as wide
open ovals that read as necklaces. Intakes `a5aed1e5` and `43794a1d` both show it, and both add the
same two aggravations: the short extender swelled into a heavy feature chain at roughly three times
its true gauge, and the shared describer hedged the category — "bracelet or anklet", "anklet or
bracelet" — so the image stage never received the word *bracelet* at all. One hedge ("a disc with a
slightly curved or heart-like silhouette") came back as an invented literal heart charm.

This is 20260808120000's diagnosis arriving from the opposite direction — compact-plus-fill is
scale-blind in both directions — so the fix follows the same proven pattern rather than a new one:
`20260810120000_chain_bracelet_preset.sql` inserts a `chain-bracelet` preset pair, self-staging
(`uses_composition = false`), with three deliberate differences from the long-chain presets:

1. **TRUE SIZE inverts the necklace scale contract.** Links are *dozens, not hundreds* and must stay
   countable; components sit LARGE against the loop; and the extender is pinned to its real
   proportion — a quarter to a third of the main chain, links one readable step larger — because the
   swollen extender was the most visible corruption in both failures.
2. **The whole piece stays inside the frame.** The necklace V crops the clasp out; on a bracelet the
   clasp and extender are scale evidence and are never cropped.
3. **The describer is category-committed.** It must call the piece a chain bracelet, never hedge,
   and returns a fixed `flat-arc` class as audit metadata.

The scene block is the live satin hero's, byte for byte. The operator's proposal of splitting
prompts into a category axis and a background axis was considered and deliberately not built into
the schema now: every category preset so far couples its scene to its pose (the necklace's ceramic
backdrop only makes sense behind a hanging piece, satin folds only under a flat lay), and a
compose-at-generation background token would reintroduce exactly the contradictory-instruction
problem the presets exist to remove. If a real need for per-category background switching arrives,
the `{{COMPOSITION_DETAIL}}` resolver pattern is the template for a `{{SCENE_DETAIL}}` token —
nothing done here blocks it. Until then, category presets own their scene.

---

### D99 — A worn hand-chain source is fit evidence, and fit means encirclement

The hand-chain preset's image half (revision "protected hero, source pose ignored") produced three
bad fits in the 2026-08-10 afternoon batch, including one whose source was photographed already
worn on a real hand — the best fit evidence an operator can supply — which the prompt then ordered
the model to discard: SOURCE POSE IS NOT THE PRODUCT was unconditional. The second cause was
subtler: "fit the real wrist section at the wrist" names a location, not a fastening, and the model
satisfied it by laying chain on top of skin — a wrist band up the forearm, a clasp displayed on the
back of the hand, a tassel glued flat along the skin.

`20260810130000_hand_chain_anchored_fit.sql` inserts the corrected image half:

1. **SOURCE POSE is scoped to loose sources.** A new WORN SOURCE block keeps an already-correct
   fit — same attachment points, same branch routing, same finger per loop — replacing only the
   hand, scene and polish. This is the necklace preset's IF-THE-SOURCE-IS-ALREADY-HANGING rule
   (D95 lineage) applied to the worn category that needed it most.
2. **WEARING AND FIT is four anchor rules, all stated as encirclement.** The wrist section
   encircles the wrist at the crease and disappears behind it; crossing branches route
   one-for-one; each finger loop encircles the base of its finger; a tassel or drop hangs under
   gravity. "Never lies across", "never crosses the knuckles", "never flat along the skin" ban the
   observed failures by name.
3. **One canonical hand pose** (back of hand to camera, wrist from an upper corner, fingertips to
   the opposite lower corner), for the same reason the necklace hero fixed one scene: at ~300
   products/month, per-image pose invention stops the catalogue looking like one shoot.

The describer half is deliberately untouched — its connection ledgers on all three failures were
accurate. The fit was lost in the image stage, not the record.

---

### D100 — Anklets guard scale in both directions, and one anklet is never a pair

The anklet preset (`20260810140000`) reuses the chain-bracelet skeleton (D98) but is not a copy
with new numbers. Three anklet-specific judgements, made ahead of the first anklet batch rather
than after its failures:

1. **Both drift directions are banned by name.** A bracelet only ever drifts up toward necklace
   scale; an anklet (22–27 cm) sits between the two and can be corrupted either way — coarsened
   links shrink it into a bracelet, refined and multiplied links stretch it into a necklace. TRUE
   SIZE states both bans; the link gauge is named as the scale witness.
2. **Dangles are the design, and their distribution is data.** Drops, bells, coins and tassels
   stay on their real attachments, fall outward from the fastened circle under their own weight,
   and keep the source's distribution — a decorated front run with plain chain behind must never
   be "tidied" into even spacing or extended further than the source carries it.
3. **The pair prior is refused in both stages.** Anklets are traditionally worn in pairs and the
   model knows it; Qimati sells `(Single Piece)`. The image prompt's HOW MANY bans adding a second
   anklet, mirroring, or background echoes; the describer must state the quantity plainly and
   never assume an unseen partner. An invented pair is invented stock, which is worse than a bad
   pose.

---

### D101 — A drafted product's category can be corrected; the freed number returns through a pool, never through the counter

*2026-08-13, owner request: "in case I chose wrong category it frees the SKU for next draft in this category and gives it the latest+1 SKU of the new category."*

The category was frozen the moment a SKU was reserved (D27), and the only remedy was a new
draft plus a burnt number. Now `release_draft_identity()` frees an UNPUBLISHED draft's number
into `freed_skus (sku_prefix, sku_number)`, and `reserve_draft_identity()` drains that pool
lowest-first — one `delete … returning` under `for update skip locked`, so two concurrent
reservations can never take the same freed number — before falling back to `next_sku()`.

Hard rule 1 is untouched: the counter still only moves forward, and `next_sku()` is still the
only mint. Release is guarded like the destructive operation it is: refused for published
drafts, refused under a live publish lease, and — when the draft ever reached Shopify —
refused unless the caller passes the exact product id it just deleted. The console flow
deletes Loupe's own DRAFT product first (ownership verified by recorded id; a product someone
activated in admin is live retail and is never deleted).

**Rejected:** decrementing the counter (out-of-order frees re-issue only the newest and
collide when the counter catches up), and reusing numbers from published-then-deleted
products (a spent retail number stays spent — the pool holds only numbers whose product
provably never went live).

**Known window, accepted:** a pooled number skips the D97 publish-time Shopify probe (which
scans from the counter upward). The handle-ownership check still refuses to overwrite a
foreign product at publish, and the D102 webhook raises counters/alerts on hand-made
products within seconds, which closes most of what the probe covered.

---

### D102 — Shopify pushes changes to Loupe; the nightly reconciliation becomes the backstop

*2026-08-13, owner request: "something changes in shopify triggers update here in backend automatically."*

An HMAC-verified webhook route (`/api/webhooks/shopify`, app client secret, timing-safe
compare) subscribes to `products/create|update|delete`, registered idempotently from the
nightly reconcile cron.

- `products/create` and `products/update` raise the per-prefix SKU counters immediately via
  the monotone `raise_sku_counter` — the NK1007 class of hand-made collision now closes in
  seconds instead of at 03:00.
- An update to a Loupe-PUBLISHED product runs a one-product comparison with exactly the D90
  comparator and keeps ONE live alert per finding in `shopify_webhook_alerts` (unique
  partial index on unresolved (product, code)); a clean read-back auto-resolves. Edits to
  DRAFT-stage products stay silent — that is the business finishing its listings.
- A deleted DRAFT-stage product releases its Loupe draft through the existing
  `delete_shopify_missing_draft` path, returning photographs to Pending immediately.
  Deleting a PUBLISHED product raises an alert a human must resolve.

A verified payload always gets a 200 even when a handler fails: Shopify's retry storm cannot
fix a Loupe-side bug, and the nightly run remains the backstop for exactly the case where
webhooks are broken.

---

### D103 — Raw uploads enter the pipeline directly, and a photograph can carry its own prompts

*2026-08-13, owner request: an Upload section that bypasses Drive, choosing "which prompts to run through, category then setting" per image.*

`intake_files` gains `source_storage_key` (the browser-uploaded source in R2 — the worker
reads it instead of Drive; everything downstream is unchanged) and `preset_slug` (the prompt
pair for THIS photograph; null means the live default, exactly today's behaviour).
`finalize_raw_image_upload` lands a verified upload in `discovered` using the manual-upload
synthetic `drive_file_id` precedent (`upload:{id}`), so every existing query shape survives.

The worker and the redo path resolve a bound pair by newest-revision-per-kind — the same D96
rule promotion uses — and fall back to the default pair WHOLE when either half is missing.
A mixed pair (bound describe, default image) is never assembled: its halves were not written
together.

**Known gap, accepted:** discarding an upload-sourced photograph before enhancement leaves
its source object under `manual/{id}/` until retention; the discard path cleans version
rows, which such a photograph does not yet have.

---

### D104 — Prompts are a category × setting matrix in code; rows materialise on first use

*2026-08-13, owner request: prompts organised as category prompts and setting/background prompts, "prompt for each category", from the reference boards in SAMPLE/.*

`src/lib/prompts/matrix.ts` holds 13 category cores and 10 scene settings. Six cores are
extracted byte-faithful from the shipped preset migrations (necklace, waist-chain,
chain-bracelet, anklet, hand-chain, bag) with exactly one surgical change: the baked scene
paragraph becomes a `{{SETTING_DETAIL}}` slot, plus the lighting/prop clauses that would
contradict a chosen scene now defer to it. Seven new cores (earrings, rings, kada-bracelet,
nose-pin, watch, indian-jewellery, hair-accessory) follow the same protection skeleton.
Settings are pure environment paragraphs authored from the owner's reference boards — never
pose, never product claims.

A combination becomes prompt ROWS (slug `category--setting`) only when first used, through
`create_prompt_version` — so validation, audit events and immutability are identical to a
hand-written revision — then both halves promote in one transaction. Re-using a combination
after the matrix improved writes a new revision, which D96 semantics pick up automatically
for both promoted defaults and bound photographs.

`tests/prompt-matrix.test.ts` runs all 130 combinations through the worker's own
`resolveImagePrompt` gate, injected and description-less. No selectable combination can die
at claim time.

**Rejected:** a third `{{SETTING}}` token resolved at enhancement time (would have touched
the certified five-place validation contract), and pre-inserting 130 pairs as migrations
(the matrix in code is the source of truth; unused combinations cost nothing).

---

### D105 — Save draft answers instantly; the Shopify push happens after the response

*2026-08-13, owner request: drafting must not lag the console.*

D60 put a full `productSet` round trip inside the Save-draft click, freezing the console for
seconds per product. The local save (the operator's typing, into Postgres) is the only part
the click now waits for; `publishDraftForOperator(…, DRAFT)` runs in `after()` — the same
pattern D52 established for redo — and reports through `draft.shopify_synced` /
`draft.shopify_push_failed` events plus the draft row's `error` column. Failure surfaces as
an amber live notice, in the draft editor, and as "Shopify draft failed" under Needs
attention; the next Draft or Publish retries by the same reserved handle (hard rule 2).
`begin_draft_publish` serialises a background push against a concurrent Publish, and a push
that loses that race yields silently — the winner reports.

The single global `busy` slot went with it: saves, deletes and uploads each carry their own
scoped in-flight state, deletes run four-wide and optimistically, and uploads run three-wide
with per-file progress. Publish remains the one deliberately exclusive act.

---

### D106 — The console re-reads the counters; a server action that cannot be reached is a visible failure

*2026-08-17, from a live report: "second listing shows same SKU as previous, third one is not
drafting and shows it's done."*

Three separate defects, none of them in `next_sku()`. The database was correct throughout —
BK392 and BK393 were reserved 2m14s apart and the counter stood at 393.

**1. The preview froze at page load.** `ConsoleScreen` seeded `categories` — which carries
`sku_counters.last_number` — once from the server render and never re-read it, while
`refreshQueueAction()` returned only the queue. `predictIdentity` is `lastNumber + 1`, so
every draft of a session predicted the same SKU. Two things move that counter without the
browser doing anything: the D105 push reserves after the response, and D102 webhooks raise it
whenever somebody creates a product in Shopify admin (six `webhook.sku_counter_raised` events
on 2026-08-17 alone, NK/ER/CB). `refreshQueueAction` now returns `{ queue, categories }` and
the console applies both. Three unsigned reads next to a snapshot that already presigns every
thumbnail.

**2. A rejected server action was silent.** Every action returns `{ ok: false }` with an
operator sentence, but a POST that never completes REJECTS instead — offline, timed out, or a
redeploy invalidating the generated action id. That threw past `handleResult`, so no error
appeared and the saving state never cleared, while `ensureDraft` had already grouped the
photographs and moved them out of Pending. `settled()` converts a rejection into the same
`ActionResult` shape the server produces, vague about the cause and specific about the
consequence: nothing was saved.

**3. An unpushed draft looked finished.** Draft `1458d9b5` held only a `draft.created` event:
no `reserved_sku`, no `shopify_product_id`, no `error`. The tile renders
`reservedSku ?? categoryName`, so it read "Kada Bracelets" — identical to a completed draft —
and Tracking ignored it because `error` was null. `isUnpushedDraft` now raises the existing
`attention` line after `UNPUSHED_DRAFT_MINUTES`. Age, not status (hard rule 5): assembling
with no Shopify product is the normal state for the seconds the background push takes, so
flagging on status alone would mark every healthy draft the moment it was saved.

**Rejected:** removing the predicted SKU entirely. Hard rule 8 requires the operator to see a
resolved `SKU · title · handle` before publishing so a wrong category is visible; the fix is
to keep the prediction honest, not to delete it.

---

### D107 — The saved SKU is reserved in the click; an empty image list means ignorance, not removal; activation in Shopify admin is a publish

*2026-08-18, from the first high-volume day (55 drafts on 2026-08-17): "images not going to
Shopify, images slow to load, SKU always showing +1, RAW keeps getting crowded, some images
not picked up."*

Five findings, five decisions. The database was correct throughout, again.

**1. Save draft reserves the identity synchronously.** D105 moved the whole Shopify push —
including `reserve_draft_identity` — behind `after()`, so the save response carried
`reservedSku: null` while the queue refresh (D106) delivered a `lastNumber` that already
included the just-issued number. `predictIdentity` therefore showed reserved + 1 on every
draft, and the operator writes these numbers on physical tags. `saveDraftAction` now runs
`reserveIdentityForSave` — the D97 counter probe followed by `reserve_draft_identity`,
extracted so publish and save run the identical guard — inside the click, and the response
carries the SKU `next_sku()` actually issued. Cost is one Shopify probe round trip (~450 ms)
on first save only; the productSet stays in `after()`. A reservation failure reports and
loses nothing: the typing was already saved.

**2. `save_product_draft` keeps the images when `p_images` is empty.** CB402 and CB406
reached Shopify with no pictures: the editor fills its image list from a preview round trip,
a fast enough Save sends `[]`, and the delete-what-was-not-sent step wiped the correct
group-time defaults `create_product_draft` had written. There is no console path that removes
every image through save — removal goes through `detach_intake_file` — so an empty list can
only be client ignorance and now leaves the rows untouched (migration
`20260818090000`). The client also adopts the bundle's server-side image list whenever its
own is still empty, so the editor never shows a grouped product as imageless. The
`draft.saved` event records the images the draft holds after the save, not the length of
what the client sent.

**3. The lightbox shows the cached thumbnail while the full file downloads.** The full-size
review is a ~2 MB PNG (measured 1.97–2.16 MB) behind a presigned URL that differs on every
snapshot, so the browser almost never has it cached and every open was seconds of black. The
~50 KB grid thumbnail — already on screen, already cached — now fills the frame, slightly
blurred, until the full image's `onLoad` swaps it out. Rejected: a mid-size derivative per
version. It fixes the same seconds for new images only after a worker change, a backfill and
more R2 objects per version; the thumbnail swap is one component and covers every existing
image today. Revisit if retailer-zoom quality checks still feel slow.

**4. A product activated in Shopify admin publishes its Loupe draft.** The business finishes
DRAFT-stage listings in admin (D90) and activates them there, so Loupe's `published` status —
which gates the Drive tidy — was unreachable for the real workflow, and /RAW held 64 files
with nothing ever moving them. The `products/update` webhook now treats `status: "active"` on
a not-yet-published Loupe draft as the publish signal: `mark_draft_published` (idempotent,
any prior status — pinned by test) followed by the same Drive housekeeping a Loupe publish
runs. A tidy failure logs and never bounces the webhook; the product is published either way.

**5. Drive reconcile runs every 5 minutes.** All 74 uploads on 2026-08-17 were picked up —
"not getting picked up" was the latency tail: three files of one batch appeared in the change
log 13.7 minutes late and waited for the 15-minute reconcile net (median upload-to-visible
139 s, p90 204 s, max 958 s). The sweep is one page of a ~60-file folder, so its cadence is
the cheap knob that bounds the worst case; Google's propagation delay itself is not ours to
fix.

**Rejected:** refetching the open bundle when the sync event lands (finding 1) — it shrinks
the wrong-SKU window instead of closing it, and merges server state into a form the operator
may be typing in. Also rejected: a client-side guard alone for finding 2 — the database rule
protects every past and future caller, including the deployed clients still running during
the rollout.

---

### D108 — Measurements are a third prompt axis, and the figures travel inside the description

The prompt matrix becomes **category × setting × measurement**. The third choice has two
values: `plain` (what every pair has always been) and `measured`.

`measured` is a contract with the photographer as much as with the model: the raw upload must
show a ruler or printed scale bar lying beside the piece, flat, in the same plane and at the
same distance from the camera. The describer is then told to read the printed unit off the
numerals, derive the millimetres-per-division ratio and measure the two or three dimensions a
buyer asks for on that kind of piece. The image stage draws those figures as flat dimension
callouts and removes the ruler itself from the frame.

**The figures ride inside the description paragraph, not in a new JSON field.** The describer
ends its paragraph with one fixed sentence, `Measured against the scale: <part> <number> mm;
…`. That is the whole reason this is a prompt change and not a pipeline change:
`parseStructuredDescription` accepts exactly two keys (`description`, `presentation`) and
nothing else, and the description already reaches the image prompt through the PRODUCT block.
A third JSON key would have meant a parser change, an `intake_files` column, a worker change,
a redo-path change and a migration — for data whose only consumer is the next prompt.

**A measurement that cannot be made is stated, not guessed.** An illegible, tilted or
out-of-plane scale makes the describer write `Measured against the scale: not legible.` and
the image rule then draws no lines, no figures and no text at all. The image prompt may print
only the digits the PRODUCT block contains — never round, convert, recompute or invent one.
A wrong number printed on the photograph a customer buys from is worse than an unmeasured
photograph.

**`plain` keeps the two-part slug** `category--setting`. Only a measured pair takes a third
part, `category--setting--measured`. Every pair already stored therefore stays the same row
and nothing is re-materialised; the existing `preset_slug` check constraint already admits
the longer form, so no migration was needed.

**Rejected:** a fourth "dimension shot" alongside the hero — one raw photograph produces one
enhanced version, and a second output would need its own version row, its own cost ceiling
and its own place in the console's image list. **Also rejected for now:** drawing the callouts
deterministically (server-side overlay on the returned PNG) rather than asking the image model
to render them. That is the accurate way to do it and is the upgrade path if the model's
rendered digits drift; it is a worker change, not a prompt change, and it was not what was
asked for.

**Ceiling to watch:** two error sources compound — the describer reading the ruler (expect a
few per cent, worse on very small pieces and any out-of-plane scale) and the image model
rendering the digits. Check the first measured batch figure by figure against the raw
photographs before trusting it at volume.

---

### D109 — Originals are never purged; retention keeps only to generated versions

*Owner decision, 2026-08-21, on the findings in `AI-Python/docs/LOUPE-INTEGRATION-PLAN.md` §1.*

D62 purged a photograph's original together with its generated versions seven days after the
product reached Shopify, because "Google Drive `/Processed` still holds the untouched original".
Measured on 2026-08-21 that backstop had failed: the database recorded 238 drive files moved to
`/Processed`, 156 were there, 80 returned 404 and 2 were trashed; 175 of 271 originals had already
been deleted from R2, and 63 more were due on the night of 24→25 August. Upload-sourced photographs
(D103) never had a Drive copy at all. The original is the only real photograph of the piece and the
reference the SKU matcher is built on, so it is now excluded at three independent points:

- `retention_candidates()` never returns a row with `kind = 'original'`;
- `mark_versions_purged()` refuses to mark one, so a stale deploy of the purge job cannot record an
  original as gone;
- `isProtectedKey()` (`src/lib/retention/protected-keys.ts`) makes `purge.ts` and the D64 discard
  path skip any key under `originals/`, `manual/`, `references/` or `identify/`, whatever the
  database says.

Generated versions and thumbnails keep purging exactly as before. `runRetentionPurge()` takes its
database and object store by injection and is no longer `server-only`, for the same reason the
Drive housekeeping is built that way: the refusal has to be provable without a real bucket
(`tests/retention-purge.test.ts`; the SQL side is `tests/retention.sql.test.ts`).

Cost of keeping originals: ~4.3 GB a month at 300 products × 1.5 photographs × 9.6 MB, under
$1/month on R2 after the free 10 GB. **Rejected:** purging originals after copying a resized
reference elsewhere — cheaper still, but a second moving part in the one path that must not fail,
for a saving that does not matter.

Applied to production 2026-08-21 16:30 IST. Verified afterwards: `retention_candidates(-365)`
returns 80 generated versions and no originals; 96 originals remain in R2.

---

### D110 — Every photograph is identified against the catalogue before any paid stage, and a human always decides

*Owner decision, 2026-08-21, on `AI-Python/docs/LOUPE-INTEGRATION-PLAN.md`.*

Drive discoveries and raw uploads now land in `identifying`, not `discovered`. `claim_intake_file()`
only claims `discovered`, so the enhancement worker is untouched; nothing is spent on a photograph
until an operator has said what it is. `request_identification()` creates one `match_events` row
and one `identify` job per photograph; the **Identify** screen shows the ten candidates the matcher
returned — in rank order, all styled alike, no score — and offers New product, Restock of <SKU>, or
Can't tell. `decide_identification()` records that once: new product and can't tell go to
`discovered` (enhancement starts, nudged immediately), restock parks the row in `restock` with a
`restock_decisions` row. Ready-image uploads are not gated: they are finished catalogue images, not
photographs of stock.

The same screen takes a photograph from the warehouse floor (`manual_uploads.target = 'identify'`,
`finalize_identify_upload()`): a match event with no intake row. **A confirmed identification
becomes a reference for that SKU** (`confirm_identification()` → `match_references`, source
`identify_confirmed`, pending sync); an unconfirmed match teaches the system nothing. This is the
self-improving loop, and it is gated on the human click by construction.

**Why no automatic decision, ever:** the score cannot separate a right top-1 from a wrong one
(raw AUC 0.63), and on phone photographs of render-referenced SKUs rank 1 is right 11 % of the time
(NIGHT3 §4a). Ten candidates and a person is the only honest interface.

**Rejected:** gating uploads only and badging Drive photographs — the owner chose all sources, for
the labelled pairs and the spend saved on restocks. **Cost of the gate:** enhancement of a Drive
drop now starts when someone clicks, not within a minute; the Identify page polls while a photograph
is queued and says plainly when the matcher is offline, and the operator can continue without
candidates.

---

### D111 — The vision work runs on the owner's laptop behind a bearer API; Loupe owns every write; search lives in Postgres

*Owner decision, 2026-08-21.*

The SigLIP2-so400m/512 + u2net pipeline needs ~3 GB resident and a GPU to be pleasant (2.9 s per
query on an M1, 10.8 s on a 2.2 GHz Xeon pair, measured). The owner's Windows laptop (RTX 3050)
runs it as `worker/` (`loupe-worker`), which talks only to `/api/worker/{heartbeat,claim,complete,
source}` with one shared `WORKER_SECRET`. It never holds a database, R2 or Drive credential: R2
keys become presigned URLs in the claim, a Drive photograph is streamed through
`/api/worker/source` with the lease token, and every completion is fenced by that UUID token
(hard rule 6), so a crashed or stale worker is harmless and a lease expires back into the queue.

Three job kinds: `sync` (the original to `LOUPE_LOCAL_ROOT/originals/<SKU>/` with a JSON sidecar
and a SQLite index — the owner's own copy of every photograph), `embed` (two views per reference,
nightly), `identify` (a query vector within seconds, daytime). Embeddings live in Postgres
(`match_embeddings`, pgvector 0.8.2, `extensions.vector(1152)`) and `match_search()` is an exact
cosine scan, max over views per SKU — milliseconds at this size, and it will stay so at a hundred
times the catalogue. The legacy catalogue (3,665 images, 2,939 SKUs) was embedded once on a T4 and
imported as index version `bakeoff-v9`; from here the index only ever grows, incrementally.

Every published product's original becomes a reference (`register_reference()`, called after every
publish and weekly by `loupe-match-register`); `scripts/backfill-match-references.ts` copied the
originals that retention purged before D109 from Drive into `references/`.

**Rejected:** a Python service on a VPS embedding queries on CPU — 10 s a query for €8.49/month is
a fallback, not the design; the `Dockerfile` builds the same worker for that role if the laptop is
too often offline. **Rejected:** the worker writing to the database directly — the route layer is
where a result becomes a decision (ten candidates from a vector), and that is Loupe's.

---

### D112 — A restock is confirmed twice, then resolved one of two ways; a superseded product is archived and zeroed

*Owner decision, 2026-08-21.*

The **Restock** section lists photographs an operator marked as a restock in Identify, with the
chosen SKU, the other candidates, and the product's live stock from Shopify. The operator confirms
once more (or sends it back to Identify), then chooses:

- **Restock existing** — types the new stock totals per variant; Loupe calls
  `inventorySetQuantities` (absolute, `ignoreCompareQuantity`, reference
  `loupe://restock/<decision>`), marks the row `restocked`, and registers the photograph as a
  reference (source `restock`) — a real photograph of that exact piece taken here, the best
  reference there is.
- **New SKU, archive the old** — the photograph re-enters the pipeline, with a new generated image
  (the operator picks a prompt pair from the existing matrix; the row goes to `discovered` carrying
  the `preset_slug`, D103) or as it is (`enhanced`, the original selected — the ready-image shape).
  At publish, `pending_supersession()` finds the decision; the old product is archived
  (`productUpdate status: ARCHIVED`) and its stock set to 0, and `record_supersession()` stamps
  `product_drafts.supersedes_sku`. Two active listings never carry the same piece.

Loupe otherwise still never touches inventory (D54). Shopify writes sit between `begin_*` and
`complete_*`; a failure is recorded on the decision (`fail_restock`) and the operator retries from
the screen. **Deferred:** attaching a newly generated image to the *existing* product on the
restock-existing path — it needs a media mutation on a live product and was not part of the first
build; the decision carries `wants_new_image` so nothing is lost.

---

### D113 — The raw-upload path never worked in production: two source constraints, one stale

*Found 2026-08-21 while testing D112.* D103 replaced the `intake_files.source` check by dropping
`intake_files_source_check`, but the original constraint (20260803120000) is named
`intake_files_source_is_known`. Both existed; the older one still refused `'upload'`, so
`finalize_raw_image_upload()` could never insert a row — zero upload-sourced photographs ever, which
PROGRESS had read as "not used yet". Fixed by `20260821176500_intake_source_admits_upload.sql`.
Lesson recorded: a migration that replaces a constraint must name the constraint it replaces, and a
test that exercises the new value would have caught this on 13 August.

---

### D114 — The necklace core stages a close draped macro, not a mid-air V

*2026-08-23.* The hanging-V brief produced images where the pendant was a small object in an
empty field and the fine chain was effectively invisible — the owner's words: "not visible at
all". The owner's reference set (CaitlynMinimalist-style editorial shots) all share one staging:
pendant large and pin-sharp, chain draped on a real surface with a soft contact shadow, both arms
leaving the top of the frame, warm window light. The necklace `imageBody` now asks for exactly
that, and the scene paragraph's surface is what the chain lies on rather than a backdrop behind a
floating piece. "Chain exits the top edge" is kept as the cue that this is neck-length, since the
close crop no longer shows true length. Other cores are unchanged; the anklet, bracelet and
waist-chain briefs were never the complaint.

---

### D115 — Necklace pose is an operator choice: two cores, not a pose axis

*2026-08-24.* One pose cannot serve all necklaces: a solid pendant sells in the close draped
macro (D114), but drops, dangle rows, both-ends connectors and layered strands need gravity — a
flat-lay scatters them at random angles. Rather than adding a fourth matrix axis (which would
reverse D104's "cores are self-staging" and touch the pair-slug format), the pose ships as a
second category core, `necklace-hanging`. The operator picks it exactly where they pick every
core — before the setting — and pairs materialise as `necklace-hanging--<setting>` through the
unchanged D104 path. The two cores share one describeBody: inspection is pose-independent.
Ceiling: if a third necklace pose ever appears, reconsider a real pose axis instead of a third core.

---

### D116 — Worn views are a category core plus a backfill script, not a pipeline change

*2026-08-24.* Worn-on-foot anklet images serve two paths with one prompt. Future uploads: a new
`anklet-worn` core (operator picks it like any core; rows materialise per D104). Existing
listings: `scripts/anklet-worn-batch.ts` reads the anklets collection best-sellers straight from
Shopify, enhances the first image with the same composed core, and appends the result via
stagedUploadsCreate → productCreateMedia with alt "Worn view (AI-styled)" — the alt doubles as
the idempotency marker. No schema, no queue, no worker involvement: a backfill of ~50 images is a
script, not a pipeline feature. The core permits skin (one lower leg and foot only), which the
other anklet core still bans; if worn views spread to more categories, lift the worn-view OUTPUT
language into a shared fragment then.

---

### D117 — Material truth is one shared block spliced into every core, not fifteen copies

*2026-08-27.* Stone rendering, metal colour, chain construction, outline fidelity and per-strand
counting are the same promise whatever the product is, and every one of them had failed in
production on some category that never received the fix. Fifteen hand-maintained copies would
have drifted within a month — the audit that prompted this found the clear-stone rule present on
exactly two of fifteen cores. So `MATERIAL_TRUTH` lives once and `withMaterialTruth()` splices it
into each composed image body immediately before OUTPUT, keeping OUTPUT last so a measurement
rule appended after it can still override its no-text clause. Cores keep only what is genuinely
category-specific: pose, scale contract, count rules, final check. The block is image-stage only;
the describer equivalent (per-strand inspection) went to the five describers where strands can
occur, not to rings or watches where it is noise. Ceiling: the block is appended verbatim to every
category, so anything added to it must be true of bags and watches as well as chains.

---

### D118 — Loupe writes the SEO title and meta description on publish

*2026-08-28.* Shopify's fallback for an empty SEO title is the bare product title ("Earrings 548"),
which is what the 28 products published on 27 Aug went live with. The catalogue-wide generator of
26 Aug (Qimati SEO changelog) established one pattern for all 3,000+ products —
`Wholesale <material> <Category> — <n> | Qimati` and a ≤160-character meta description naming
material, finish, design number, the per-unit note (earrings sold as a pair, anklets singly) and
the ₹1,000 prepaid minimum. `src/lib/publish/seo.ts` renders that pattern from the category
prefix, the padded SKU number and the selected material, and `productSet` receives it as `seo`.

Two rules baked in: title and description are always sent together (Shopify's `SEOInput` replaces
the whole object — a description-only update nulls the title), and a custom material gets no
finish or rust claim because Loupe cannot know what it is coated with.

