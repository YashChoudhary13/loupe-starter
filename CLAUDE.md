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
| Watches, Hand Chains, Nose Pins, Jewellery Box, Bags, Hair Accessories, Indian Jewellery, Brass | **TBD — ask before inventing** | | |

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
All Shopify, Drive, OpenAI and R2 calls are server-side. This tool publishes to a live store. Auth is Google sign-in restricted to the company domain — not a shared password.

*As built (Phase 1):* every table has RLS **enabled with zero policies**, which in Postgres is a default deny — the publishable key can read and write nothing, and that is enforced by the database rather than by remembering to be careful. `service_role` bypasses RLS and is reachable only through `src/lib/supabase/server.ts`, which starts with `import 'server-only'`; a client component importing it fails the build. Prove it with `npm run verify:isolation`, don't assume it.

⚠️ **Open question for Phase 4:** `.env` has no `ALLOWED_EMAIL_DOMAIN`, and `SEED_ADMIN_EMAIL` is a personal gmail.com address — a gmail.com address, not `qimati.in`. A strict company-domain check would lock out the only seeded admin. Decide whether the rule is domain membership, presence in `app_users`, or both.

**8. Never block publish silently.**
Block on empty/zero price, and on zero stock unless explicitly ticked. Show the resolved `SKU · title · handle` as a read-only preview before publish, so a wrong category is visible.

---

## Image enhancement

**Model: OpenAI `gpt-image-2`, pinned to a dated snapshot** (e.g. `gpt-image-2-2026-04-21`), never `chatgpt-image-latest` — that pointer moves when ChatGPT's model moves and the catalogue's look would drift silently.

- **Output 2048×2048.** Shopify's recommended size for square product images; hard max 5000×5000 / 20 MB.
- Tested cost ≈ **$0.07/image**, range $0.07–$0.20 depending on quality tier.
- Input limit 50 MB per image; up to 16 reference images; masks supported with an alpha channel.
- The **original is immutable and kept forever** — every version derives from it. Originals live permanently in Google Drive; R2 caches one only while the item is in the queue.

Put the model behind one interface so it stays swappable:

```ts
enhance(input: Buffer, prompt: string, opts): Promise<{ image: Buffer; costUsd: number; model: string }>
```

**The enhancement prompt is configuration, not code.** It lives in the `prompts` table, is editable in the UI, and is versioned. It must never be hardcoded — replacing five ChatGPT tabs with one hardcoded string just moves the problem.

⚠️ **D5 is contradicted by `.env`.** The working `.env` carries `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image`, `OPENROUTER_GEMINI_MODEL` **and** `OPENROUTER_OPENAI_IMAGE_MODEL=openai/gpt-image-2`, and no `OPENAI_API_KEY`. That is a live bake-off, not the settled choice this section describes. Resolve it before Phase 3 and update D5 — do not let the code pick silently.

---

## Storage

- **Cloudflare R2** bucket `loupe-images` — private. Access via presigned URLs only: one for the console to display, one for Shopify to fetch at publish.
  ⚠️ `.env` says `R2_BUCKET=loupe-image` (**singular**). One of the two is wrong; the Cloudflare dashboard decides. Confirm before Phase 3 writes anything.
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

`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_PASSWORD` are different credentials. The
service-role key is a JWT for the PostgREST API; it cannot authenticate a Postgres wire
connection, which is what `db:push` and the direct-connection tests need.

## UI

`docs/DESIGN.md` holds the design tokens and component rules. `design/console-mockup.html` and `design/tracking-mockup.html` are the visual reference — open them before building any screen. Build with **shadcn/ui + Tailwind**, themed to those tokens.

## Verifying

Don't report a phase done on "it ran". Each phase has explicit success criteria in `docs/phases/`. Meet those, and paste the evidence into `docs/PROGRESS.md`. For anything touching SKU allocation, prove it **under concurrency** — parallel publishes must never collide — not just on a single happy-path call.
