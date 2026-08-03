# Loupe — Qimati Listing Console

Internal tool for Qimati (qimati.in), a wholesale jewellery Shopify store in Jaipur. It replaces a manual process where one person enhanced photos across five ChatGPT tabs and hand-typed every Shopify listing.

**Stack:** Next.js (App Router) + TypeScript · Supabase Postgres · Cloudflare R2 · Vercel
**Volume:** ~300 products/month, 1–2 images each

---

## Session protocol — follow this every session

**First action of every session:** read `docs/PROGRESS.md`. It is the only reliable record of what exists and what state it is in. Do not infer progress from the code alone — half-finished work looks identical to finished work.

**Also read** `docs/DECISIONS.md` before changing any architectural choice. Decisions in there were made deliberately; if you think one is wrong, say so and ask, don't silently reverse it.

**Last action of every session:** append an entry to `docs/PROGRESS.md` using the template at the top of that file. Do this even if the session was short or went badly — a recorded failure is worth more than a gap.

**Whenever you make a decision the phase prompt didn't specify** — a library choice, a schema change, a workaround for something that didn't behave as documented — append it to `docs/DECISIONS.md` with one line of reasoning.

**Never mark a phase complete** until every success criterion in its prompt file has been met *and demonstrated*. Record the evidence in `docs/PROGRESS.md`. "It ran without errors" is not evidence.

---

## What it does

The photographer drops photos into one flat Google Drive folder. A watcher records each file, a worker enhances it via `gpt-image-2`, and an operator groups images into products, picks category / material / colours, types a price, and publishes to Shopify. A tracking page surfaces anything that failed or stalled.

Of the twelve fields on a product, only **two** need human judgement: **category** and **price**. Everything else is derived.

---

## Domain facts (verified against the live store — do not guess these)

### Categories

Category drives the SKU prefix, the title, the tag and therefore the collection. **Each prefix has its own number sequence.**

| Category | SKU prefix | Title pattern | Shopify tag |
|---|---|---|---|
| Necklaces | `NK` | `Necklace {n}` | `Necklace` |
| Earrings | `ER` | `Earrings {n}` | `earrings` |
| Kada Bracelets | `BK` | `Bracelet Kada {n}` | `kada` |
| Chain Bracelets | `CB` | `Chain Bracelet {n}` | `cb` |
| Rings | `RS` | `Rings {n}` | `Rings` |
| Anklets | `AK` | `Anklets {n} (Single Piece)` | `anklets` |
| Nose Pins | `NP` | `Nose Pin {n}` | **unconfirmed — publish is blocked** |
| Watches, Hand Chains, Jewellery Box, Bags, Hair Accessories, Indian Jewellery, Brass | **TBD — ask before inventing** | | |

`NP` was added in Phase 2 with `shopify_tag` **NULL**: the prefix and title pattern are confirmed against the live store, the tag is not. Publish refuses any category whose tag is null rather than guessing one — an invented tag drops the product out of its collection silently, which is worse than a blocked publish. Fill the tag in and the category works with no code change.

**`{n}` is zero-padded to a MINIMUM of three digits, in the SKU *and* in the title.** Confirmed against live data:

```
   4 → NP004 · "Nose Pin 004"        87 → AK087 · "Anklets 087 (Single Piece)"
 221 → RS221 · "Rings 221"          970 → NK970 · "Necklace 970"
```

A minimum, never a fixed width — `1000` stays `1000`. ⚠️ Postgres `lpad(n, 3, '0')` **truncates**, so `lpad('1000', 3, '0')` is `'100'`; use `public.pad_sku_number()`, which wraps the length in `greatest(3, length(n))`. Bare `lpad` here issues the 1000th necklace `NK100` and collides with an existing product, silently. See D20.

Existing tags are inconsistent (`cb` vs `Necklace` vs `anklets`). **Match the existing tag exactly.** Collections appear to be tag-driven, so a "tidier" tag would silently drop the product out of its collection.

⚠️ **Every product also needs a second tag, `NEWEST`** — stated by the business on
2026-07-30 after reviewing the first console-published product, then confirmed against
Necklace 970, Earrings 453, Chain Bracelet 353 and Anklets 087 in the live catalogue.
The exact all-caps casing is load-bearing: a near-miss (`Newest`, `newest`, `New`)
publishes successfully and drops the product out of its collection silently.

Titles take an **optional free-text suffix**: `(Adjustable)`, `(Huggies)`, `(Single Piece)`, `(Light Rose gold)`. Title is *not* purely category + number.

`product_type` is currently `jewelery` / `Jewelery` / blank. Write `Jewellery` consistently on new products.

### Materials

The normal choices are **`304`**, **`316L`**, **`Brass`**. The operator may enter a
one-off custom material when needed; it stays on that product draft and does not silently
expand the global suggestions.

Write the material to the metafield **`custom.material`** (`single_line_text_field`) — a defined interface, not a guess: the live store has no material metafield at all today, so Loupe is establishing it. The theme template must later read the same `namespace.key`. See D21.

Write clean `descriptionHtml` containing Qimati's six standard bullets, with the selected
material in the first bullet. The operator may rarely edit the default as plain text.
Escape it before producing HTML; never accept raw HTML or reproduce the WhatsApp CSS
classes (`class="_aupe copyable-text xkrh14z"`) and `<h5>` tags found in the old catalogue.
See D50, which supersedes D6.

### Colours

Product options. Free text, remembered, ranked by usage **per category** (Necklaces → Gold/Silver; Rings → Red/White/Green). Variants currently **share the parent SKU** (`AK011` on both Gold and Silver) — keep that convention.

Stock may be set independently for every colour. `product_draft_variants.stock`
is authoritative; the old parent `product_drafts.stock` value is only a
compatibility mirror when options exist. Publish blocks when the **sum** of the
option rows is zero unless the operator explicitly allows zero stock.

Normalise on save (trim, collapse spaces, Title Case) and fuzzy-match on entry, or the vocabulary rots into `Rose Gold` / `rose gold` / `Rosegold` within a month. An admin merge tool is required, not optional.

### Numbered tray choices

Some photographs show a tray/box of separately numbered pieces (often 30 rings).
The customer chooses the visible number, so these publish as one Shopify option
named exactly **`Number`**, with values `1` through the operator-selected count
and independent stock per number. Numbered variants share the parent product SKU,
just like colour variants. A product uses one option mode at a time: no option,
`Colour`, or `Number`; a tray number already identifies the exact visible piece,
so Loupe does not multiply it by a second colour dimension. The console supports
up to 100 numbered choices on one product.

### Known damage in the live data

- `Rings 221` and `Rings 222 (Adjustable)` **both carry SKU `RS221`** — the hand-maintained counter collided. `RS218`, `RS220` and `RS222` are missing from the sequence.
- Handles like `rings-224set-of-10-different-rings-for-750-copy` — products are created by duplicating old ones, and Shopify's `-copy` suffix survives in the public URL.
- Variant weight is `0` on every product. Qimati uses fixed shipping rates, so this is the
  correct value and does not affect fulfilment.

---

## Hard rules

These are the things that break the business if they're wrong.

**1. SKU numbers come from an atomic Postgres counter — never from querying Shopify's max.**
Shopify enforces no uniqueness on SKU; it accepts collisions silently. Drafts, deletions and in-flight writes make any "current max" query lie. The counter is the source of truth. The console may *display* a predicted SKU, but the authoritative number is allocated server-side inside the publish transaction. This is not a theoretical concern — see `RS221` above.

*As built (Phase 1):* `public.next_sku(p_prefix text) returns integer`. One `UPDATE … RETURNING`, which takes the row lock; concurrent callers serialise automatically. Raises SQLSTATE `22023` on an unknown prefix rather than inventing a sequence. `EXECUTE` is revoked from `anon` and `authenticated` so nobody can burn numbers from a browser. **Never rewrite it as a SELECT followed by an UPDATE** — measured, that returns 13 distinct numbers for 100 concurrent products. `tests/next-sku.concurrency.test.ts` asserts the shape of the *deployed* function, not just the migration file. `product_drafts.reserved_sku` and `reserved_handle` are additionally UNIQUE as a database-level backstop.

**2. Publishing is idempotent by handle.**
Reserve SKU + handle → record `publishing` → call `productSet` identified by handle → mark published. A retry reuses the **same** handle so `productSet` updates rather than creating a second product.

**3. The Drive folder is an inbox, not a state machine.**
Insert the DB row **before** any work is attempted. A file's presence in RAW never means "unprocessed" — the DB says what's true. `drive_file_id` is UNIQUE, so re-scanning the whole folder is always safe. Moving files to `/Processed/` is housekeeping; if it fails, nothing breaks.

**4. Retries are bounded, then a human looks.**
5 attempts with backoff (0, 1m, 5m, 20m, 1h), then `failed`. Never infinite — one corrupt HEIC would retry forever and burn credit. Classify errors as *retryable* (429, 5xx, timeout, network) or *permanent* (corrupt file, unsupported format, too large, model refusal, malformed response, cost ceiling exceeded). Permanent errors skip retries entirely.

**5. Alert on age, not status.**
300 images is not 300 products. A file that is `enhanced` but ungrouped is normal — it's waiting for an operator. The same file ungrouped after 24 hours is a problem. Status-based alerting cries wolf and people stop reading it.

**6. Crashed workers self-heal via leases.**
A worker claiming a row sets `lease_expires_at` **and receives a UUID `lease_token`**.
Every completion compares that token before changing state, so a worker that wakes after
expiry cannot overwrite the replacement worker's claim. A sweeper clears both ownership
fields and returns expired leases to the queue. Without the deadline, one crash strands a
file forever; without the token, a stale worker can corrupt the worker that recovered it.

**7. Secrets never reach the browser.**
All Shopify, Drive, image-model and R2 calls are server-side. This tool publishes to a live store.

**Shopify auth is the OAuth `client_credentials` grant, not a static `shpat_` token.** The app is a Shopify-managed install; `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` are exchanged at `POST https://{shop}/admin/oauth/access_token` for an offline access token that **expires in 24 hours** (`expires_in: 86399`). Consequences that are easy to get wrong:

- There is no long-lived token to paste anywhere. Anything that fetches a token once at boot works today and silently stops publishing tomorrow.
- The token must be cached with its expiry, refreshed **proactively** (Loupe refreshes 4 h before expiry, so ~20 h into a 24 h token), and a `401` must mean *invalidate, refresh, retry once* — not fail.
- Concurrent publishes must share **one** in-flight token fetch, or twenty parallel publishes make twenty token calls.
- The client id and secret are **not** the token. Never log or persist the minted token.

*As built (Phase 2):* `src/lib/shopify/token.ts`. Clock and `fetch` are injectable so the refresh path is provable without waiting a day — `tests/shopify-token.test.ts`.

*As built (Phase 1):* every table has RLS **enabled with zero policies**, which in Postgres is a default deny — the publishable key can read and write nothing, and that is enforced by the database rather than by remembering to be careful. `service_role` bypasses RLS and is reachable only through `src/lib/supabase/server.ts`, which starts with `import 'server-only'`; a client component importing it fails the build. `npm run verify:isolation` proves the Supabase service-role key *and* the Shopify client secret are both absent from the client bundle.

**Console sign-in is Google sign-in against the `app_users` table.** `ALLOWED_EMAIL_DOMAIN` is deliberately unset and `SEED_ADMIN_EMAIL` is deliberately a gmail.com address — **this is by design, not a bug.** Membership of `app_users` is the authorisation rule. A strict `qimati.in` domain check would lock out the only admin. Do not "fix" this.

**8. Never block publish silently.**
Block on empty/zero price, and on zero stock unless explicitly ticked. Show the resolved `SKU · title · handle` as a read-only preview before publish, so a wrong category is visible.

*As built (Phase 2):* `src/lib/publish/validate.ts` returns **every** reason at once, each naming the field it is about, and a blocked publish reserves nothing — it burns no SKU number. Five blocks: empty/zero price, zero stock (unless ticked), missing material, unknown weight, unconfirmed category tag. The same invariants are raised again inside `reserve_draft_identity()`, so nothing that reaches the database another way can route around them.

**NULL and 0 are different values and always will be.** `default_weight_g` NULL means
*nobody has said* and blocks; 0 means *someone said zero* and publishes as 0 g. Use `??`,
never `||` — `||` discards a deliberate 0 for being falsy. Every category's default is 0
because Qimati uses fixed shipping rates; weight is not part of its shipping calculation,
so 0 g is the correct settled value and not a cutover item. See D19.

---

## Image enhancement

**Route: OpenRouter.** `OPENROUTER_API_KEY` serves both model calls. D51 moves the
provider-qualified model onto each immutable prompt version and exposes ten curated choices
per stage in `/prompts`; the current defaults remain `openai/gpt-5.6-sol` and
`openai/gpt-image-2`. The env values remain compatibility defaults, not the live selector.
One key and billing account keep model swaps out of provider-specific SDKs.

**Enhancement is a durable two-call pipeline.**

1. A describer sees only the 1024 px-long-edge source copy and the live default
   `prompts.kind = 'describe'` body and selected model. It uses
   `DESCRIBE_REASONING_EFFORT=minimal` where the provider supports that control and must
   return one strict JSON object with exactly `description` and `presentation`. Description
   is one factual 60–100 word paragraph. Presentation must be one of the database enum's
   six values: `pair-upright`, `flat-curve`, `standing-three-quarter`, `angled-band`,
   `flat-arc`, or `tray-grid`. The paragraph, enum, model and actual cost are cached on
   `intake_files`. A retry or redo with both cached values makes zero describe calls.
2. The worker resolves the live default `prompts.kind = 'image'` body. With
   `INJECT_DESCRIPTION=true`, the cached text replaces the literal
   `{{PRODUCT_DESCRIPTION}}`; otherwise the entire PRODUCT block is removed. Application
   code—not model prose—maps the enum to one audited composition paragraph and replaces
   the one literal `{{COMPOSITION_DETAIL}}` token. A prompt with a missing, repeated or
   unresolved token is rejected before image generation. The exact post-resolution bytes
   sent to the image model are stored in
   `image_versions.prompt_text`, together with `description_injected` and
   `description_missing`.

Describe attempts use the same bounded retry schedule as intake. On the fifth describe
failure the row deliberately stays claimed, records `description_missing_at`, removes the
PRODUCT block, assigns the deterministic `flat-curve` fallback, records a queryable
fallback reason and continues to image generation. Malformed JSON and invented classes
follow the same bounded path; free-form model composition never reaches the image prompt.
A describer outage degrades the image; it does not stop the pipeline.
`MAX_COST_USD_PER_DESCRIPTION=0.02` guards accidental reasoning spend independently of the
image ceiling. A successful describe response above that limit does **not** retry the same
expensive configuration: it records the missing description and continues to the image call
immediately.

**Phase 3C status:** the bounded composition implementation is deployed and visually
verified, but Phase 3C is not complete. The current `openai/gpt-5.6-sol` five-product
acceptance cost $0.014816–$0.016851 per description, above the required `< $0.006` gate.
Production stays on that model until an explicit decision selects a replacement and a fresh
comparable five-product image run proves strict JSON, factual accuracy, correct classes,
image fidelity and the 87-item tray count. The isolated cost evaluation is evidence, not
permission to change `DESCRIBE_MODEL`.

**That cost work was deliberately deferred past Phase 4** (D43). Phase 4 completed without
changing any model. In Phase 5 the owner explicitly brought curated model selection into
scope (D51). Phase 3C stays *not complete* until a newly selected configuration passes its
own comparable acceptance evidence; exposing a selector is not that evidence.

**Phase 5 is complete.** `/prompts` lets an authorised operator create an immutable
non-current prompt version, then deliberately promote it. Promotion leaves exactly one
current prompt, validates the image template tokens and records the actor. A redo is a
durable image-only job: it reserves the next version and deterministic R2 paths, reuses the
cached description and presentation class, and never invokes the descriptor. The new image
is appended unselected so original and prior generated versions remain available.

Redo marks `generation_started_at` immediately before the paid request. Recovery completes
from an already-written deterministic R2 object without another provider call; if the paid
request started but no object exists, automatic retry stops because billing is ambiguous.
Starting another redo is an explicit operator action with a new job and version. See D52.

**Phase 6 is complete.** `/tracking` is the protected operating view for failed, stalled
and mismatched work. A failed intake needs attention immediately; an enhanced, ungrouped
photograph becomes stalled only after 24 hours. Photograph and product counts remain
separate and use the Asia/Kolkata day boundary. Retry, skip and duplicate-review actions
are validated in SQL and audited.

Every decodable source receives a deterministic 64-bit perceptual hash: 32×32 grayscale,
2D DCT and median-thresholded 8×8 low-frequency coefficients. Hamming distance `<= 8`
raises a warning only. The operator decides whether to dismiss the canonical pair or mark
one intake duplicate; duplicate detection never blocks Publish and never decides on its
own. See D53.

Shopify reconciliation is a daily authenticated, read-only job at `03:00 Asia/Kolkata`.
One leased run compares each Loupe-published product's existence, ACTIVE state, handle,
title, product type, required category and `Newest` tags, description HTML, material,
variants, weight and recorded media/order. Extra tags and changing stock are not drift.
Runs and issues are durable and visible in Tracking; Loupe records differences but never
repairs Shopify automatically. See D54.

**Do not pin a dated snapshot.** The mitigation for silent style drift is not a pin — it is the record: `image_versions` stores `model` and `prompt_text` on **every** row, so the exact model and exact prompt behind any published image are recoverable, and a drift is diagnosable after the fact instead of merely prevented in theory. A pin would also freeze the catalogue on whichever snapshot OpenRouter happens to expose, which is not something this project controls. See D5.

- **Never rely on image shape defaults.** OpenAI image requests send the env-backed `size`
  and `quality` explicitly. Other curated OpenRouter image models use the common `1:1`
  aspect-ratio contract and their square result is converted to the configured
  `IMAGE_SIZE=1280x1280` PNG; a non-square response is refused rather than stretched.
  `IMAGE_QUALITY=medium` remains the OpenAI production default. The source copy sent to
  every model is downscaled to a 1024 px long edge first.
- `MAX_COST_USD_PER_IMAGE=0.20` is a hard guard. Persist the returned version and actual
  `usage.cost`, then fail the intake permanently with the actual cost in the readable
  reason when it exceeds the ceiling. Never estimate cost from a price table.
- OpenRouter's current `/images` contract requires each `input_references` entry to be an
  object shaped as `type: "image_url"` plus `image_url.url`; a bare data-URL string is
  rejected. `tests/openrouter-enhancement.test.ts` locks this wire shape.
- The first real Step 0 edit explicitly used `size: "2048x2048"` and `quality: "high"`
  (not `auto`), cost **$0.44116**, and took **222.242 s**. It is historical capability
  evidence, not the production configuration.
- The production-config Step 0 used a 1024×1024 input copy with
  `size: "1280x1280"` and `quality: "medium"`. OpenRouter returned an actual
  1280×1280 PNG in **65.358 s** for **$0.073376** (3,408 total tokens), below the
  $0.20 ceiling. Size and the lower-cost quality tier both reached the provider.
- Loupe rejects source files over exactly 50,000,000 bytes. OpenRouter's live
  `gpt-image-2` metadata advertises up to 16 `input_references`; Step 0 exercised one.
  It does not advertise a mask parameter on this route, so do not assume masks are
  available through OpenRouter without a fresh capability check.
- The original R2 object is byte-for-byte the Drive download and immutable at its
  deterministic key. Every version derives from it. Phase 3B never moves the Drive file to
  Processed; Drive housekeeping belongs to the later phase that produces `published`.

**Production worker:** `POST /api/cron/enhance`, every minute through the existing Vault +
`CRON_SECRET` pattern. A tick claims at most two items with the Phase 3A UUID token and
stops before the Vercel limit. Before every R2 or database write it rechecks the unexpired
token. Generated/original keys are deterministic, so an R2 upload followed by a process
crash is recovered without a duplicate version.

Put the model behind one interface so it stays swappable:

```ts
enhance(input: Buffer, prompt: string, opts): Promise<{ image: Buffer; costUsd: number; model: string }>
```

**The enhancement prompt is configuration, not code.** It lives in the `prompts` table, is editable in the UI, and is versioned. It must never be hardcoded — replacing five ChatGPT tabs with one hardcoded string just moves the problem.

`GEMINI_API_KEY` / `GEMINI_IMAGE_MODEL` remain in `.env` as the direct-to-Google fallback if OpenRouter is unavailable. There is deliberately no `OPENAI_API_KEY` — OpenAI is reached through OpenRouter.

---

## Storage

- **Cloudflare R2** bucket **`loupe-image`** — singular, private. Access via presigned URLs only: one for the console to display, one for Shopify to fetch at publish.
  *Confirmed 2026-07-28 against the Cloudflare dashboard: the live bucket is named `loupe-image`, location **APAC**, created 28 Jul.* `.env` was right; earlier drafts of this file and D4 said `loupe-images` and were wrong. The Phase 0 note about an `ENAM` bucket needing recreation is also resolved — the surviving bucket is APAC.
- **Supabase is the database only.** Do not use Supabase Storage; a `loupe-images` bucket there was created and abandoned early on.
- Paths: `originals/{intake_file_id}.{jpg|png|webp}`,
  `versions/{intake_file_id}/v{n}.png`, and
  `versions/{intake_file_id}/v{n}_thumb.webp`.
- Generate a ~50 KB thumbnail beside every version. The queue grid uses thumbnails, never full images.
- **Retention:** delete versions ~7 days after publish. Shopify serves the published image from its own CDN thereafter.

---

## Conventions

- TypeScript strict. No `any` in domain logic.
- Server-side secrets only; no service keys in client bundles.
- Every state transition writes a row to `events` — every listing must trace back to its source photo, prompt and version.
- Money in **paise** (integer), never floats.
- Timestamps `timestamptz`, UTC. Display in Asia/Kolkata.
- Migrations in `supabase/migrations/`, never hand-edited schema. Apply with `npm run db:push`.
- One commit per meaningful unit of work, with a message that explains *why*.

## Environment

The working credentials file is **`.env` in the repo root** — gitignored, live production
values. `.env.local` also works and overrides it. `.env.local.example` is the committed
template and must never contain real values; keep it in sync when you add a variable.

There is a second file at `../.env.local.example`, one level **above** this repo, which
despite its name holds real values. It is outside the repo and is not the source of truth.

**Multi-line values must be base64 or quoted.** dotenv terminates an unquoted value at
the first newline, so raw multi-line JSON silently becomes `{` — every presence check
passes and the failure surfaces much later, somewhere unhelpful.
`GOOGLE_SERVICE_ACCOUNT_JSON` is validated properly by
`src/lib/google/service-account.ts`; call `googleServiceAccount()` once at start-up, and
`/health` shows the result. See D26.

**`SHOPIFY_STORE_DOMAIN=qimti.myshopify.com` is correct.** "qimti", not "qimati" — confirmed
at `admin.shopify.com/store/qimti`. It is the **test store**, and it is password-protected.
The live store is a later cutover; nothing in this repo points at it yet. Do not "fix" the
spelling. At cutover, the only Shopify configuration changes are `SHOPIFY_STORE_DOMAIN`, a
set of app credentials for the live store, and re-running `npm run seed:counters`. That scan
must report `NK7801`, `BK3367` and `AK0834` as the exact excluded catalogue typos from D69;
they must never become counter maxima.

`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_PASSWORD` are different credentials. The
service-role key is a JWT for the PostgREST API; it cannot authenticate a Postgres wire
connection, which is what `db:push` and the direct-connection tests need.

## UI

`docs/DESIGN.md` holds the design tokens and component rules. `design/console-mockup.html` and `design/tracking-mockup.html` are the visual reference — open them before building any screen. Build with **shadcn/ui + Tailwind**, themed to those tokens.

## Verifying

Don't report a phase done on "it ran". Each phase has explicit success criteria in `docs/phases/`. Meet those, and paste the evidence into `docs/PROGRESS.md`. For anything touching SKU allocation, prove it **under concurrency** — parallel publishes must never collide — not just on a single happy-path call.
