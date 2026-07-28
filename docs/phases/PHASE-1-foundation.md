# Phase 1 — Foundation

Paste everything inside the fence into a fresh Claude Code session.

**Scope:** repo scaffold, database schema, seed data, atomic SKU counter.
**Out of scope:** Shopify, Google Drive, R2, image processing, and any UI beyond a health page.

---

````
Read CLAUDE.md, docs/PROGRESS.md and docs/DECISIONS.md before doing anything. They contain
the domain facts, the current state of the project, and settled decisions. Follow them.

PHASE 1 SCOPE: repo scaffold, database schema, seed data, and the atomic SKU counter.
OUT OF SCOPE: Shopify, Google Drive, R2, image processing, any UI beyond a health page.
Do not build ahead. If you finish early, improve the tests, not the scope.

## 1. Scaffold

- Next.js (App Router) + TypeScript strict + Tailwind
- Two Supabase clients, kept apart:
  - server-only client using the service_role key, with `import 'server-only'` at the top
  - browser client using the publishable key (sb_publishable_…), NOT the legacy anon JWT
  The service_role key must be impossible to import from a client component. Prove it, don't assume it.
- `.env.local.example` — every variable, each with a comment saying what it is and where it
  comes from. No real values. (A filled example already exists in the repo root; keep them in sync.)

## 2. Schema — as migrations in supabase/migrations/

categories
  id, name, sku_prefix (unique), title_pattern, shopify_tag,
  default_weight_g, default_stock, sort_order, active

sku_counters
  sku_prefix (pk, fk categories.sku_prefix), last_number int not null default 0, updated_at

materials
  id, name (unique), sort_order, active          -- seeded: 304, 316L, Brass

colours
  id, name (unique, normalised), created_at, archived_at
colour_usage
  colour_id, category_id, usage_count, last_used_at        -- pk (colour_id, category_id)

intake_files
  id, drive_file_id (UNIQUE, not null), filename, drive_md5, bytes,
  status, attempts int default 0, last_error, last_error_code, error_class,
  lease_expires_at, phash,
  discovered_at, enhanced_at, grouped_at, published_at,
  product_draft_id (nullable fk)
  -- status: discovered | enhancing | enhanced | grouped | published | failed | duplicate | skipped
  -- error_class: retryable | permanent

image_versions
  id, intake_file_id fk, version_no int, kind,              -- kind: original | generated
  storage_key, width, height,
  prompt_text, model, cost_usd, parent_version_id (self fk),
  is_selected bool, thumb_key, created_at

product_drafts
  id, category_id fk, material_id fk, title_suffix, price_paise int, weight_g, stock,
  status,                                        -- assembling | publishing | published | failed
  reserved_sku, reserved_handle,
  shopify_product_id, published_at, created_by, error

product_draft_images
  product_draft_id fk, image_version_id fk, position int, colour_id (nullable fk)
product_draft_variants
  product_draft_id fk, colour_id fk, position int

prompts
  id, name, body, is_default bool, created_by, created_at, archived_at

events
  id, entity_type, entity_id, event, detail jsonb, actor, created_at

Index for the queries this system actually runs:
  intake_files (status, discovered_at)                    -- the "what has stalled" query
  intake_files (lease_expires_at) where status = 'enhancing'
  intake_files (phash)
  product_drafts (status)
  events (entity_type, entity_id, created_at)

Money is paise (integer). Timestamps are timestamptz.

## 3. The atomic counter — the critical piece

A Postgres function `next_sku(p_prefix text) returns int` that increments and returns
sku_counters.last_number in a SINGLE atomic statement (UPDATE … RETURNING, which takes a
row lock). It must raise if the prefix is unknown rather than silently creating a row.

Do NOT implement this as a SELECT followed by an UPDATE. The live store already carries two
different products with SKU RS221 because that is how it was done by hand. See DECISIONS.md D2.

## 4. Seed

Seed `categories` and `sku_counters` from the table in CLAUDE.md — the six confirmed
categories only. Do not invent prefixes for the eight TBD categories; leave them out.

Leave every `last_number` at 0 with a clear TODO. Real starting values arrive in Phase 2 and
must be the TRUE MAX per prefix, not a row count — the existing sequences have gaps.

Seed `materials` with 304, 316L, Brass.

## 5. Health page

`/health` — server-rendered, shows database connectivity and a row count per table. No auth yet.

## SUCCESS CRITERIA — meet all of these before reporting done

1. `npm run dev` boots clean and `/health` renders real counts from the database.
2. Migrations apply cleanly to a completely empty database, in order, with no manual steps.
3. A test calls `next_sku('NK')` 100 times CONCURRENTLY and asserts the result is exactly 100
   distinct consecutive integers — no duplicates, no gaps. RUN IT and paste the output.
   This is the single most important test in the project.
4. `next_sku('NOPE')` raises rather than returning null or creating a row.
5. Demonstrate that the service_role key cannot be reached from any client component.

## BEFORE YOU FINISH

- Append a session entry to docs/PROGRESS.md using the template at the top of that file.
  Include the concurrency test output as evidence.
- Append anything you decided that this prompt didn't specify to docs/DECISIONS.md.
- Note anything in CLAUDE.md that turned out to be wrong or ambiguous, and fix it.
- Commit with a message explaining what and why.
````
