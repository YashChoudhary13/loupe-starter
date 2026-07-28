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

Existing tags are inconsistent (`cb` vs `Necklace` vs `anklets`). **Match the existing tag exactly.** Collections appear to be tag-driven, so a "tidier" tag would silently drop the product out of its collection.

Titles take an **optional free-text suffix**: `(Adjustable)`, `(Huggies)`, `(Single Piece)`, `(Light Rose gold)`. Title is *not* purely category + number.

`product_type` is currently `jewelery` / `Jewelery` / blank. Write `Jewellery` consistently on new products.

### Materials

Exactly three, fixed: **`304`**, **`316L`**, **`Brass`**. Not free text.

Write the material to a **metafield**. The six description bullets render from the theme template. Do **not** write description HTML into the product body — the existing catalogue contains WhatsApp CSS classes (`class="_aupe copyable-text xkrh14z"`) and `<h5>` tags on body copy, pasted in by hand. Don't reproduce that.

### Colours

Product options. Free text, remembered, ranked by usage **per category** (Necklaces → Gold/Silver; Rings → Red/White/Green). Variants currently **share the parent SKU** (`AK011` on both Gold and Silver) — keep that convention.

Normalise on save (trim, collapse spaces, Title Case) and fuzzy-match on entry, or the vocabulary rots into `Rose Gold` / `rose gold` / `Rosegold` within a month. An admin merge tool is required, not optional.

### Known damage in the live data

- `Rings 221` and `Rings 222 (Adjustable)` **both carry SKU `RS221`** — the hand-maintained counter collided. `RS218`, `RS220` and `RS222` are missing from the sequence.
- Handles like `rings-224set-of-10-different-rings-for-750-copy` — products are created by duplicating old ones, and Shopify's `-copy` suffix survives in the public URL.
- Variant weight is `0` on every product, so weight-based shipping cannot work.

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
5 attempts with backoff (0, 1m, 5m, 20m, 1h), then `failed`. Never infinite — one corrupt HEIC would retry forever and burn credit. Classify errors as *retryable* (429, 5xx, timeout, network) or *permanent* (corrupt file, unsupported format, too large, model refusal). Permanent errors skip retries entirely.

**5. Alert on age, not status.**
300 images is not 300 products. A file that is `enhanced` but ungrouped is normal — it's waiting for an operator. The same file ungrouped after 24 hours is a problem. Status-based alerting cries wolf and people stop reading it.

**6. Crashed workers self-heal via leases.**
A worker claiming a row sets `lease_expires_at`. A sweeper returns expired leases to the queue. Without this, one crash strands a file forever in a status that looks busy.

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

---

## Image enhancement

**Route: OpenRouter.** `OPENROUTER_API_KEY` with `OPENROUTER_OPENAI_IMAGE_MODEL` (`openai/gpt-image-2`) and `OPENROUTER_GEMINI_MODEL`. One key, one billing account, and swapping model or provider is a config change rather than a new SDK.

**Do not pin a dated snapshot.** The mitigation for silent style drift is not a pin — it is the record: `image_versions` stores `model` and `prompt_text` on **every** row, so the exact model and exact prompt behind any published image are recoverable, and a drift is diagnosable after the fact instead of merely prevented in theory. A pin would also freeze the catalogue on whichever snapshot OpenRouter happens to expose, which is not something this project controls. See D5.

- **Output 2048×2048.** Shopify's recommended size for square product images; hard max 5000×5000 / 20 MB.
- Tested cost ≈ **$0.07/image**, range $0.07–$0.20 depending on quality tier.
- Input limit 50 MB per image; up to 16 reference images; masks supported with an alpha channel.
- The **original is immutable and kept forever** — every version derives from it. Originals live permanently in Google Drive; R2 caches one only while the item is in the queue.

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
- Paths: `originals/{intake_file_id}.jpg` and `versions/{intake_file_id}/v{n}.jpg`
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

**`SHOPIFY_STORE_DOMAIN=qimti.myshopify.com` is correct.** "qimti", not "qimati" — confirmed
at `admin.shopify.com/store/qimti`. It is the **test store**, and it is password-protected.
The live store is a later cutover; nothing in this repo points at it yet. Do not "fix" the
spelling. At cutover, the only changes are `SHOPIFY_STORE_DOMAIN`, a set of app credentials
for the live store, and re-running `npm run seed:counters`.

`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_PASSWORD` are different credentials. The
service-role key is a JWT for the PostgREST API; it cannot authenticate a Postgres wire
connection, which is what `db:push` and the direct-connection tests need.

## UI

`docs/DESIGN.md` holds the design tokens and component rules. `design/console-mockup.html` and `design/tracking-mockup.html` are the visual reference — open them before building any screen. Build with **shadcn/ui + Tailwind**, themed to those tokens.

## Verifying

Don't report a phase done on "it ran". Each phase has explicit success criteria in `docs/phases/`. Meet those, and paste the evidence into `docs/PROGRESS.md`. For anything touching SKU allocation, prove it **under concurrency** — parallel publishes must never collide — not just on a single happy-path call.
