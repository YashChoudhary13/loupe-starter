# SKU Matching in Loupe — Implementation Plan

> Status 2026-08-21 evening: Tasks 1–10 built, tested and applied to production (see PROGRESS.md); Task 11 docs in the same session. Deferred: attaching a new generated image to an existing product on the restock-existing path (D112).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Every photograph entering Loupe is identified against the catalogue before any money is spent on it; operators confirm new product / restock; confirmed photographs become references; the heavy vision work runs on the owner's Windows GPU laptop, Loupe owns every database write, and similarity search lives in Postgres.

**Architecture:** Loupe (Next.js on Railway) gates intake in a new `identifying` status, creates `match_jobs`, and exposes a tiny bearer-secret worker API (`/api/worker/*`). A Python worker on the Windows laptop (RTX 3050) polls that API, syncs originals to local disk, embeds with SigLIP2-so400m/512 + u2net crop, and posts vectors back; Loupe stores them in pgvector (`match_embeddings`) and runs the top-10 search in SQL. Decisions (`decide_identification`, restock paths, confirmed references) are SQL functions Loupe calls; the worker never holds database or R2 credentials. An optional CPU worker on a VPS runs the same code for `identify` jobs when the laptop is offline.

**Tech Stack:** Next.js 16 App Router · TypeScript strict · Supabase Postgres 17 (+ `vector` 0.8.2) · Cloudflare R2 (`loupe-images`) · vitest · Python 3.11+, torch (CUDA), timm 1.0.28, rembg 2.0.78, onnxruntime-gpu, requests.

## Global Constraints

- Repo: `/Users/yash/Desktop/Qimati/loupe-starter`. Production deploys on push to `main` (Railway). Migrations apply with `npm run db:push` — **each file is its own transaction**, so an `alter type … add value` must be in its own file, applied before any file that uses the value.
- Every table: `enable row level security`, no policies. Every RPC: `revoke execute … from public, anon, authenticated; grant execute … to service_role`. Every state transition inserts into `public.events`. `src/lib/tables.ts` and `tests/schema.test.ts` must list every table and enum value exactly.
- Never delete a key under `originals/`, `manual/`, `references/`, `identify/` (D109, `isProtectedKey`).
- Never auto-decide a match. Ten candidates, rank order, no score shown, no "best match" styling.
- Loupe owns all database writes. The worker writes only through `/api/worker/*`, which validates a UUID lease token (hard rule 6) before any RPC.
- Reference-image pipeline is byte-for-byte `AI-Python/loupe-audit/cpu_bench.py`: u2net alpha at ≤768 px → 99 %-mass box + 25 % margin, background kept → pad to square (edge) → 768 px view → 512 px bicubic → SigLIP2 vision tower (`vit_so400m_patch16_siglip_512`, weights = `visual.*` slice of `timm/ViT-SO400M-16-SigLIP2-512` `open_clip_model.safetensors`) → L2-normalised 1152-d. Both views (`full`, `crop`) are stored; the search takes the max over views per SKU.
- Worker credentials: `LOUPE_BASE_URL`, `WORKER_SECRET`, `WORKER_ID`, `LOUPE_LOCAL_ROOT`. Nothing else.
- Session protocol of `CLAUDE.md`: append `docs/DECISIONS.md` for every new decision (D110+), `docs/PROGRESS.md` at session end.

---

## File map

**Loupe — SQL**
- `supabase/migrations/20260821170000_intake_status_identifying_restock.sql` — enum values only.
- `supabase/migrations/20260821171000_match_tables.sql` — `vector` extension; `match_events`, `match_jobs`, `match_references`, `match_embeddings`, `restock_decisions`; `product_drafts.supersedes_sku`.
- `supabase/migrations/20260821172000_identification_gate.sql` — `request_identification()`, `discover_intake_file()` and `finalize_raw_image_upload()` land in `identifying`, `decide_identification()`.
- `supabase/migrations/20260821173000_worker_rpcs.sql` — `claim_match_job()`, `complete_match_job()`, `fail_match_job()`, `store_match_embedding()`, `match_search()`, `worker_heartbeat()`.
- `supabase/migrations/20260821174000_identify_uploads.sql` — `manual_uploads.target` admits `'identify'`; `finalize_identify_upload()`, `confirm_identification()`.
- `supabase/migrations/20260821175000_reference_registration.sql` — `register_reference()`, `register_published_originals()`.
- `supabase/migrations/20260821176000_restock.sql` — `begin_restock()`, `complete_restock_existing()`, `begin_new_sku_from_restock()`, `record_supersession()`.

**Loupe — TypeScript**
- `src/lib/match/types.ts` — shared types (Candidate, MatchEventView, JobKind…).
- `src/lib/match/read-model.ts` — identify queue, restock queue, candidate display data.
- `src/lib/match/actions.ts` (in `src/app/(shell)/identify/actions.ts` and `src/app/(shell)/restock/actions.ts`) — server actions.
- `src/lib/match/worker-api.ts` — claim/complete/heartbeat handlers (pure, injected deps).
- `src/app/api/worker/claim/route.ts`, `…/complete/route.ts`, `…/heartbeat/route.ts`.
- `src/app/(shell)/identify/page.tsx` + `src/components/identify/IdentifyScreen.tsx`.
- `src/app/(shell)/restock/page.tsx` + `src/components/restock/RestockScreen.tsx`.
- `src/lib/shopify/inventory.ts` — `setAvailableQuantities()`, `archiveProduct()`, `readVariantInventory()`.
- `src/lib/match/register.ts` — post-publish reference registration; `src/app/api/cron/match-register/route.ts`.
- `scripts/backfill-match-references.ts`, `scripts/import-catalogue-embeddings.ts`.
- Edits: `src/lib/tables.ts`, `src/lib/tracking/classify.ts`, `src/lib/tracking/read-model.ts`, `src/components/console/Sidebar.tsx`, `src/components/upload/UploadScreen.tsx`, `src/lib/manual-upload/server.ts`, `src/lib/publish/publish-product.ts`, `src/lib/env.ts`, `scripts/configure-cron.ts`, `.env.local.example`.

**Worker — Python (`worker/` in this repo)**
- `worker/loupe_worker/api.py` — HTTP client for `/api/worker/*`.
- `worker/loupe_worker/store.py` — local originals tree + `index.sqlite` + sidecar JSON.
- `worker/loupe_worker/vision.py` — model + u2net + pipeline (verbatim from `cpu_bench.py`).
- `worker/loupe_worker/jobs.py` — `sync`, `embed`, `identify` handlers.
- `worker/loupe_worker/cli.py` — `loupe-worker run --kinds sync,identify --daemon` / `--until-empty`.
- `worker/tests/test_vision.py`, `worker/tests/test_jobs.py` (fake API).
- `worker/README.md`, `worker/run-daytime.bat`, `worker/run-nightly.bat`, `worker/Dockerfile` (VPS CPU fallback).

---

## Status model (the traceability the owner asked for)

| entity | column | values |
|---|---|---|
| `intake_files.status` | enum | … + `identifying` (waiting for match + human), `restock` (human confirmed a restock; inventory action pending), `restocked` (done) |
| `match_events.status` | text | `queued` (job created) → `matched` (candidates stored) → `decided` |
| `match_events.decision` | text | `new_product` · `restock` · `confirmed` · `none_of_these` · `skipped` |
| `match_references.status` | text | `pending_sync` → `synced` → `queued` → `indexed` · `failed` · `retired` (timestamps `synced_at`, `embedded_at`, `indexed_at`) |
| `match_jobs.status` | text | `queued` → `claimed` → `done` · `failed` |
| `restock_decisions.path` | text | `restock_existing` · `new_sku_archive_old` |
| `restock_decisions.status` | text | `pending` → `inventory_set` / `draft_created` → `completed` |

---

### Task 1: Enum values (own migration) + schema test

**Files:**
- Create: `supabase/migrations/20260821170000_intake_status_identifying_restock.sql`
- Modify: `tests/schema.test.ts:92-103`

- [x] **Step 1: Update the schema test to expect the new values**

```ts
  it('intake_status holds the full lifecycle', () => {
    expect(report.enums.intake_status).toEqual([
      'discovered', 'enhancing', 'enhanced', 'grouped', 'published', 'failed', 'duplicate', 'skipped',
      'identifying', 'restock', 'restocked',
    ])
  })
```

- [x] **Step 2: Run it — expect FAIL (values absent)**: `npx vitest run tests/schema.test.ts -t "intake_status"`

- [x] **Step 3: Write the migration**

```sql
-- D110: a photograph is identified against the catalogue before any paid stage.
-- Enum additions live alone in this file: db-push wraps each file in a transaction
-- and Postgres refuses to use a value in the transaction that added it.
alter type public.intake_status add value if not exists 'identifying';
alter type public.intake_status add value if not exists 'restock';
alter type public.intake_status add value if not exists 'restocked';
```

- [x] **Step 4: `npm run db:push`, rerun the test — PASS. Commit:** `feat: intake_status gains identifying, restock, restocked (D110)`

---

### Task 2: Match tables + pgvector

**Files:**
- Create: `supabase/migrations/20260821171000_match_tables.sql`
- Modify: `src/lib/tables.ts`, `tests/schema.test.ts` (table list assertion reads `TABLES`)
- Test: `tests/match-schema.sql.test.ts`

**Interfaces (produced):** tables below; later tasks reference these exact columns.

- [x] **Step 1: Migration**

```sql
create extension if not exists vector with schema extensions;

-- One row per identification shown to a human: the exact query, the exact ten, the decision.
create table public.match_events (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  surface           text not null check (surface in ('upload', 'drive', 'identify')),
  intake_file_id    uuid references public.intake_files (id) on delete set null,
  query_storage_key text not null,
  query_sha256      text,
  status            text not null default 'queued' check (status in ('queued', 'matched', 'decided')),
  model             text,
  index_version     text,
  crop_box          integer[],
  candidates        jsonb,                 -- [{"rank":1,"sku":"NK845","handle":"…","score":0.71}] as shown
  matched_at        timestamptz,
  latency_ms        integer,
  decided_at        timestamptz,
  decided_by        text,
  decision          text check (decision in ('new_product', 'restock', 'confirmed', 'none_of_these', 'skipped')),
  chosen_sku        text,
  chosen_rank       smallint,
  reference_id      uuid,                  -- set when this photograph became a reference
  constraint match_events_decision_is_attributed
    check (decision is null or (decided_at is not null and decided_by is not null)),
  constraint match_events_pick_names_sku
    check (decision is null or decision not in ('restock', 'confirmed') or chosen_sku is not null)
);
create index match_events_intake_idx on public.match_events (intake_file_id) where intake_file_id is not null;
create index match_events_status_idx on public.match_events (status, created_at);
create index match_events_chosen_idx on public.match_events (chosen_sku) where chosen_sku is not null;

-- Every image the matcher may compare against, with its lifecycle on the laptop.
create table public.match_references (
  id              uuid primary key default gen_random_uuid(),
  sku             text not null,
  handle          text,
  title           text,
  image_url       text,                    -- public CDN URL for catalogue rows; null for R2 rows
  storage_key     text,                    -- R2 key for Loupe rows; null for catalogue rows
  sha256          text,
  source          text not null check (source in ('catalogue', 'loupe_original', 'restock', 'identify_confirmed')),
  intake_file_id  uuid references public.intake_files (id) on delete set null,
  match_event_id  uuid references public.match_events (id) on delete set null,
  status          text not null default 'pending_sync'
                  check (status in ('pending_sync', 'synced', 'queued', 'indexed', 'failed', 'retired')),
  added_at        timestamptz not null default now(),
  added_by        text,
  synced_at       timestamptz,
  local_path      text,
  embedded_at     timestamptz,
  indexed_at      timestamptz,
  index_version   text,
  last_error      text,
  retired_at      timestamptz,
  constraint match_references_has_bytes check (image_url is not null or storage_key is not null),
  constraint match_references_one_per_intake unique (intake_file_id)
);
create index match_references_sku_idx on public.match_references (sku) where retired_at is null;
create index match_references_status_idx on public.match_references (status);

create table public.match_embeddings (
  reference_id uuid not null references public.match_references (id) on delete cascade,
  view         text not null check (view in ('full', 'crop')),
  embedding    extensions.vector(1152) not null,
  model        text not null,
  created_at   timestamptz not null default now(),
  primary key (reference_id, view)
);

-- The worker queue. One row per unit of work; leases and tokens as for intake (hard rule 6).
create table public.match_jobs (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('sync', 'embed', 'identify')),
  reference_id     uuid references public.match_references (id) on delete cascade,
  match_event_id   uuid references public.match_events (id) on delete cascade,
  status           text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed')),
  attempts         integer not null default 0,
  worker_id        text,
  lease_token      uuid,
  lease_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  finished_at      timestamptz,
  last_error       text,
  constraint match_jobs_has_subject check (reference_id is not null or match_event_id is not null)
);
create index match_jobs_queue_idx on public.match_jobs (kind, created_at) where status = 'queued';
create index match_jobs_lease_idx on public.match_jobs (lease_expires_at) where status = 'claimed';

create table public.match_workers (
  worker_id    text primary key,
  device       text,
  kinds        text[],
  last_seen_at timestamptz not null default now(),
  version      text
);

create table public.restock_decisions (
  id                   uuid primary key default gen_random_uuid(),
  intake_file_id       uuid not null unique references public.intake_files (id) on delete cascade,
  match_event_id       uuid not null references public.match_events (id),
  sku                  text not null,
  old_shopify_product_id text,
  path                 text check (path in ('restock_existing', 'new_sku_archive_old')),
  quantities           jsonb,             -- [{"variant_id":"gid://…","inventory_item_id":"gid://…","label":"Gold","before":3,"after":15}]
  new_draft_id         uuid references public.product_drafts (id) on delete set null,
  wants_new_image      boolean,
  preset_slug          text,
  status               text not null default 'pending' check (status in ('pending', 'inventory_set', 'draft_created', 'completed', 'failed')),
  created_at           timestamptz not null default now(),
  created_by           text not null,
  completed_at         timestamptz,
  last_error           text
);

alter table public.product_drafts add column supersedes_sku text;
comment on column public.product_drafts.supersedes_sku is
  'Set when this draft replaces an existing product after a restock decision: at publish the old product is archived and its inventory zeroed (D112).';

alter table public.match_events     enable row level security;
alter table public.match_references enable row level security;
alter table public.match_embeddings enable row level security;
alter table public.match_jobs       enable row level security;
alter table public.match_workers    enable row level security;
alter table public.restock_decisions enable row level security;
```

- [x] **Step 2: `src/lib/tables.ts`** — append `'match_events', 'match_references', 'match_embeddings', 'match_jobs', 'match_workers', 'restock_decisions'`.

- [x] **Step 3: Test `tests/match-schema.sql.test.ts`** — connects with `pgClient()`, asserts `select relrowsecurity from pg_class where relname = 'match_events'` is true for all six, and `select extname from pg_extension where extname = 'vector'` exists.

- [x] **Step 4: `npm run db:push`; `npx vitest run tests/match-schema.sql.test.ts tests/schema.test.ts`; commit:** `feat: match tables, pgvector, restock decisions (D110)`

---

### Task 3: The identification gate

**Files:**
- Create: `supabase/migrations/20260821172000_identification_gate.sql`
- Modify: `src/lib/tracking/classify.ts`, `src/lib/tracking/read-model.ts` (`canSkip` excludes `identifying`/`restock`/`restocked`)
- Test: `tests/identification-gate.sql.test.ts`, `tests/tracking-classify.test.ts`

**Interfaces (produced):**
- `request_identification(p_intake_file_id uuid, p_surface text, p_actor text) returns uuid` — idempotent; creates `match_events(queued)` + `match_jobs(identify)` for the intake's source object (`originals/{id}.{ext}` if present, else `intake_files.source_storage_key`, else Drive download key… see below).
- `decide_identification(p_match_event_id uuid, p_decision text, p_sku text, p_rank smallint, p_actor text) returns void`.

Note on Drive photographs: the original is only in R2 after the enhancement worker downloads it. The gate therefore needs the bytes before enhancement. `request_identification` for a Drive row creates a `sync`-style `identify` job whose payload carries `drive_file_id`; the **worker API** (Task 4) resolves the bytes: for `source_storage_key`/`originals/` keys it presigns R2; for a Drive row it returns a short-lived Drive download URL obtained with the service account (`drive.files.get` `alt=media` via `googleDriveClient().download()` streamed through Loupe: `GET /api/worker/source/{job_id}` with the lease token). Keep Drive credentials in Loupe.

- [x] **Step 1: SQL test (red)** — insert an intake row via `discover_intake_file(...)` and assert `status = 'identifying'` and exactly one `match_jobs` row of kind `identify` with a `match_events` row `status = 'queued'`; calling it again changes nothing. Then `decide_identification(event, 'new_product', null, null, 'test')` → intake `discovered`, event `decided`; `decide_identification(event, 'restock', 'NK845', 3, 'test')` on a second row → intake `restock`, `restock_decisions` row `pending` with `sku = 'NK845'`; a decision on an already-decided event raises `55000`.

- [x] **Step 2: Migration**

```sql
create or replace function public.request_identification(
  p_intake_file_id uuid, p_surface text, p_actor text
) returns uuid
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_file public.intake_files%rowtype;
  v_event_id uuid;
  v_key text;
begin
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then raise exception 'request_identification: no intake_file %', p_intake_file_id using errcode = '22023'; end if;
  select id into v_event_id from public.match_events
   where intake_file_id = p_intake_file_id and status <> 'decided' limit 1;
  if v_event_id is not null then return v_event_id; end if;
  -- The bytes the worker should read: the browser-uploaded source (D103), else the
  -- Drive file (fetched through Loupe, never by the worker), else the original.
  v_key := coalesce(v_file.source_storage_key, 'drive:' || v_file.drive_file_id);
  insert into public.match_events (surface, intake_file_id, query_storage_key, status)
  values (p_surface, p_intake_file_id, v_key, 'queued') returning id into v_event_id;
  insert into public.match_jobs (kind, match_event_id) values ('identify', v_event_id);
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'match.requested',
          jsonb_build_object('match_event_id', v_event_id, 'surface', p_surface), p_actor);
  return v_event_id;
end $$;
```

`discover_intake_file`: replace the literal `'discovered'` in the insert with `'identifying'` (the oversize/format failure branch still moves to `failed`), and after the `intake.discovered` event add `perform public.request_identification(v_id, 'drive', p_source);`. `finalize_raw_image_upload`: insert with `'identifying'`, then `perform public.request_identification(v_intake_id, 'upload', p_actor);`. Copy both function bodies verbatim from their latest migration and change only those lines.

```sql
create or replace function public.decide_identification(
  p_match_event_id uuid, p_decision text, p_sku text, p_rank smallint, p_actor text
) returns void
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_event public.match_events%rowtype;
begin
  if p_actor is null or btrim(p_actor) = '' then raise exception 'decide_identification: p_actor is required' using errcode = '22023'; end if;
  select * into v_event from public.match_events where id = p_match_event_id for update;
  if not found then raise exception 'decide_identification: no match_event %', p_match_event_id using errcode = '22023'; end if;
  if v_event.status = 'decided' then
    raise exception 'decide_identification: already decided' using errcode = '55000',
      hint = 'This photograph was already decided. Reload the page.';
  end if;
  if p_decision not in ('new_product', 'restock', 'skipped') then
    raise exception 'decide_identification: % is not a decision for an intake photograph', p_decision using errcode = '22023';
  end if;
  update public.match_events
     set status = 'decided', decision = p_decision, chosen_sku = p_sku, chosen_rank = p_rank,
         decided_at = now(), decided_by = p_actor
   where id = p_match_event_id;
  if p_decision = 'restock' then
    update public.intake_files set status = 'restock' where id = v_event.intake_file_id and status = 'identifying';
    insert into public.restock_decisions (intake_file_id, match_event_id, sku, created_by)
    values (v_event.intake_file_id, p_match_event_id, p_sku, p_actor)
    on conflict (intake_file_id) do nothing;
  else
    update public.intake_files set status = 'discovered', next_attempt_at = now()
     where id = v_event.intake_file_id and status = 'identifying';
  end if;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', v_event.intake_file_id, 'match.decided',
          jsonb_build_object('match_event_id', p_match_event_id, 'decision', p_decision, 'sku', p_sku, 'rank', p_rank), p_actor);
end $$;
```

Revoke/grant both as usual.

- [x] **Step 3: `classify.ts`** — before the `skipped` branch:

```ts
  if (row.status === 'identifying') {
    const stalled = ageMs(row.discoveredAt, now) >= STALE_UNGROUPED_MS
    return stalled
      ? { group: 'attention', tone: 'stalled', statusLabel: 'Waiting to be identified', reason: 'Nobody has said whether this is a new product or a restock for 24 hours. Open Identify.' }
      : { group: 'progress', tone: 'running', statusLabel: 'Identifying', reason: 'Matching against the catalogue; an operator decides next in Identify.' }
  }
  if (row.status === 'restock') {
    return { group: 'attention', tone: 'stalled', statusLabel: 'Restock to confirm', reason: 'Confirmed as a restock; the stock change is waiting in Restock.' }
  }
  if (row.status === 'restocked') {
    return { group: 'complete', tone: 'complete', statusLabel: 'Restocked', reason: 'Stock updated and the photograph kept as a reference.' }
  }
```

Add the three cases to `tests/tracking-classify.test.ts` (one assertion each, mirroring the existing tests' shape).

- [x] **Step 4: `npm run db:push`; tests green; commit:** `feat: photographs wait in identifying until an operator decides (D110)`

**Deployment note:** from this deploy on, nothing enhances until someone clicks in Identify (Task 5). Deploy Tasks 3–6 together (one push) so the operators have the screen the moment the gate exists.

---

### Task 4: Worker API (claim / complete / heartbeat / source)

**Files:**
- Create: `supabase/migrations/20260821173000_worker_rpcs.sql`, `src/lib/match/worker-api.ts`, `src/lib/match/types.ts`, `src/app/api/worker/{claim,complete,heartbeat}/route.ts`, `src/app/api/worker/source/[jobId]/route.ts`
- Modify: `src/lib/env.ts` (`workerSecret`), `.env.local.example`
- Test: `tests/worker-rpcs.sql.test.ts`, `tests/worker-api.test.ts`

**Interfaces (produced):**

```
POST /api/worker/heartbeat  {worker_id, device, kinds[], version}             → 204
POST /api/worker/claim      {worker_id, kinds[], lease_seconds?}              → 200 job | 204 nothing
   job = { id, kind, lease_token, lease_expires_at,
           reference?: {id, sku, handle, source_url, filename, sha256, local_path?},   // sync, embed
           event?:     {id, source_url, surface} }                                     // identify
POST /api/worker/complete   {job_id, lease_token, result}                     → 200 {ok:true}
   result (sync):     {local_path, sha256, bytes}
   result (embed):    {embeddings: {full: number[1152], crop: number[1152]}, model, crop_box}
   result (identify): {embedding: number[1152], model, crop_box, fallback_full_frame, timing_ms}
POST /api/worker/complete   {job_id, lease_token, error: {message, retryable}} → 200 {ok:true}
GET  /api/worker/source/{jobId}?token=<lease_token>                           → bytes (Drive-sourced jobs only)
```

All bearer `WORKER_SECRET` (constant-time compare, same helper style as `src/lib/cron/auth.ts`).

- [x] **Step 1: SQL** — `claim_match_job(p_worker text, p_kinds text[], p_lease_seconds int)` (SKIP LOCKED, returns job + subject columns; bumps `attempts`; sets token/lease), `complete_match_job(p_job uuid, p_token uuid, p_result jsonb)` (token check; per kind: `sync` → reference `synced`, `local_path`, `synced_at`; `embed` → reference `indexed`, `embedded_at`, `indexed_at`, `index_version = to_char(now(),'YYYY-MM-DD')` — embeddings are stored by a separate call; `identify` → nothing here, the route runs the search first), `fail_match_job(p_job, p_token, p_error, p_retryable)` (retryable → back to `queued` up to 4 attempts, else `failed` + reference `failed`), `store_match_embedding(p_reference uuid, p_view text, p_embedding extensions.vector, p_model text)` (upsert), `match_search(p_embedding extensions.vector, p_limit int default 10) returns table (sku text, handle text, score real)`:

```sql
  select r.sku, max(r.handle) as handle, max(1 - (e.embedding <=> p_embedding))::real as score
    from public.match_embeddings e join public.match_references r on r.id = e.reference_id
   where r.retired_at is null and r.status = 'indexed'
   group by r.sku order by score desc limit p_limit;
```

and `record_match_candidates(p_event uuid, p_candidates jsonb, p_model text, p_crop_box int[], p_latency_ms int)` (event → `matched`). `worker_heartbeat(p_worker, p_device, p_kinds, p_version)` upserts `match_workers`.

- [x] **Step 2: `worker-api.ts`** — pure handlers taking `{db, store, drive, presign}` by injection: `claimJob(input, deps)` → calls `claim_match_job`, resolves `source_url`: `storage_key`/`source_storage_key`/`originals/…` → `presign(key, 3600)`; `drive:<id>` → `${baseUrl}/api/worker/source/${job.id}?token=${lease}`. `completeJob(input, deps)`: for `identify` results → `match_search` → `record_match_candidates` → `complete_match_job`; for `embed` → two `store_match_embedding` → `complete_match_job`. Vector is passed as a string literal `'[0.1,0.2,…]'` (pgvector text input). Tests with fakes: wrong token → 409; identify completion writes exactly ten candidates ranked; embed completion stores two views.

- [x] **Step 3: routes** — thin; `runtime = 'nodejs'`; 401 without the secret; `maxDuration = 60`.

- [x] **Step 4: `db:push`; tests; commit:** `feat: worker API — claim, complete, heartbeat, source (D111)`

---

### Task 5: Identify screen (queue + camera)

**Files:**
- Create: `supabase/migrations/20260821174000_identify_uploads.sql`, `src/lib/match/read-model.ts`, `src/app/(shell)/identify/{page.tsx,actions.ts,loading.tsx}`, `src/components/identify/IdentifyScreen.tsx`
- Modify: `src/lib/manual-upload/server.ts` (`target: 'ready' | 'raw' | 'identify'`, `finalizeIdentifyUpload()`), `src/components/console/Sidebar.tsx` (link "Identify"), `src/lib/live/types.ts` (`match.requested`, `match.matched`, `match.decided` refresh the page)
- Test: `tests/identify-uploads.sql.test.ts`

**Interfaces:**
- `finalize_identify_upload(p_upload_id, p_sha256, p_actor) returns uuid` — verifies the `manual_uploads` row has `target = 'identify'`, creates `match_events(surface 'identify', query_storage_key = upload.storage_key)` + `match_jobs(identify)`; no intake row.
- `confirm_identification(p_match_event_id, p_decision, p_sku, p_rank, p_actor) returns void` — for `identify` events: `confirmed` (with sku/rank) or `none_of_these`; on `confirmed` inserts `match_references (sku, storage_key = query key, source 'identify_confirmed', match_event_id, status 'pending_sync', added_by)` + `match_jobs(sync)` + sets `match_events.reference_id`. **Reference only after confirmation — never at match time.**
- `loadIdentifyQueue()` → `IdentifyItem[]`: `{matchEventId, intakeFileId|null, surface, filename, thumb: SignedImage|null, status, candidates: CandidateView[]|null, requestedAt, workerSeen: string|null}`; `CandidateView = {rank, sku, handle, title, thumbUrl, score}` — `title`/`thumbUrl` from `match_references` (`title`, `image_url`) for the SKU, else from `product_drafts` (title pattern + signed thumb of the selected version), else SKU only.

- [x] UI: two sections. **Waiting** — one card per `queued|matched` event: photo (signed thumb), ten candidate tiles in rank order (equal styling), buttons `New product` · `Restock of <pick>` (select from the ten or type a SKU) · `Can't tell — enhance anyway` (intake rows) / `It's this one` · `None of these` (identify rows). While `queued`: "Matching… worker last seen 12 s ago" (from `match_workers`); if no heartbeat for 2 min: "The matcher is offline — the photograph is safe; decide later or continue as new". **Camera** — `<input type="file" accept="image/*" capture="environment">`, presigned PUT via `beginManualUpload(operator, input, 'identify')`, `finalizeIdentifyUploadAction`, then the card appears in Waiting. The page re-reads on the live heartbeat events.
- [x] `db:push`; tests; `npm run typecheck && npm run lint`; commit: `feat: Identify — queue of waiting photographs and camera identification (D110)`

---

### Task 6: Upload screen + console counts

- [x] `UploadScreen.tsx`: tile state `queued` copy becomes "Waiting in Identify" with a link to `/identify`; header button text stays "Enhance" only for the upload step; the "in the pipeline" link points to `/identify` when any tile is queued.
- [x] `queue.ts` `loadPipelineActivity`: add `identifying` count → `PipelineActivity.identifying`; Sidebar shows the count next to Identify (reads the snapshot via the existing live update if present, else server-rendered).
- [x] Commit: `feat: upload tiles hand off to Identify`

**Push Tasks 3–6 together.** Then in production: the next Drive drop or upload appears in Identify within a minute.

---

### Task 7: The Windows worker

**Files:** `worker/pyproject.toml`, `worker/loupe_worker/{__init__,api,store,vision,jobs,cli}.py`, `worker/tests/{test_vision,test_jobs}.py`, `worker/README.md`, `worker/run-daytime.bat`, `worker/run-nightly.bat`, `worker/get-weights.py`, `worker/Dockerfile`.

**Interfaces (consumed):** the HTTP contract in Task 4.

- [x] **vision.py** — `load_model(device)`: `timm.create_model('vit_so400m_patch16_siglip_512', pretrained=False, num_classes=0)`, `load_file(weights)` stripping `visual.trunk.`, `strict=True`; fp16 on CUDA, fp32 on CPU. `generous_box`, `pad_to_square`, `view`, `embed(pils) -> np.ndarray (n,1152) L2-normalised` — copied verbatim from `AI-Python/loupe-audit/cpu_bench.py`. `get-weights.py` downloads the `visual.*` byte range of `timm/ViT-SO400M-16-SigLIP2-512/open_clip_model.safetensors` and writes `weights/siglip2_so400m_512_visual.safetensors` (reuse `AI-Python/loupe-audit/build_visual_safetensors.py` logic; 1.72 GB). u2net via `rembg.new_session('u2net', providers=['CUDAExecutionProvider','CPUExecutionProvider'])`.
- [x] **store.py** — `LOUPE_LOCAL_ROOT/originals/<sku or _unassigned>/<reference_id>.<ext>` + `<reference_id>.json` sidecar `{reference_id, sku, handle, title, intake_file_id, source, sha256, bytes, synced_at, loupe_storage_key}`; `index.sqlite` table `references(reference_id primary key, sku, handle, local_path, sha256, synced_at, embedded_at)`. `save(job, bytes) -> local_path`, `path_for(reference_id)`.
- [x] **jobs.py** — `handle_sync(job, api, store)`: GET `source_url` (stream, verify `sha256` when given) → `store.save` → `complete({local_path, sha256, bytes})`. `handle_embed(job, api, store, vision)`: open `store.path_for` (re-download if missing) → full + crop views → `embed` → `complete({embeddings:{full,crop}, model, crop_box})`. `handle_identify(job, api, vision)`: GET source → crop view → `embed` → `complete({embedding, model, crop_box, fallback_full_frame, timing_ms})`. Any exception → `fail(job, message, retryable)`.
- [x] **cli.py** — `loupe-worker run --kinds sync,identify [--daemon --poll 3] [--until-empty] [--device cuda|cpu] [--claim-delay 0]`; heartbeat every 30 s; graceful Ctrl-C; logs one line per job.
- [x] **tests** — `test_vision.py`: a synthetic image with a bright square on white gives a box around the square (+25 % margin) and `pad_to_square` output is square; `test_jobs.py`: a fake `api` object records `complete`/`fail` calls; a sync job writes the file and sidecar; an identify job posts a 1152-vector.
- [x] **README + .bat** — install (`py -3.11 -m venv .venv`, `pip install torch --index-url https://download.pytorch.org/whl/cu124`, `pip install -e .`), `get-weights.py`, `.env` with the four variables, Task Scheduler: daily 02:00 `run-nightly.bat` (`--kinds sync,embed --until-empty`), at logon `run-daytime.bat` (`--kinds sync,identify --daemon`). `Dockerfile` (python:3.12-slim, CPU torch) for the VPS fallback: `CMD ["loupe-worker","run","--kinds","identify","--daemon","--device","cpu","--claim-delay","5"]`.
- [x] Commit: `feat: loupe-worker — local sync, nightly embedding, identify on the owner's GPU (D111)`

---

### Task 8: Reference registration (publish hook, backfill, weekly sweep)

**Files:** `supabase/migrations/20260821175000_reference_registration.sql`, `src/lib/match/register.ts`, `src/app/api/cron/match-register/route.ts`, `scripts/backfill-match-references.ts`, `scripts/configure-cron.ts` (job `loupe-match-register`, `30 20 * * 6`).

- [x] `register_reference(p_intake_file_id, p_sku, p_handle, p_title, p_storage_key, p_source, p_actor) returns uuid` — idempotent on `intake_file_id`; inserts `match_references(pending_sync)` + `match_jobs(sync)` + `events 'match.reference_added'`. `register_published_originals(p_limit int) returns int` — for published drafts whose intake files have an unpurged original and no reference: calls `register_reference` with `storage_key = originals/…`; returns count.
- [x] `publish-product.ts`: after `mark_draft_published` succeeds, `await registerDraftOriginals(draftId)` in a try/catch that only logs (publishing must not fail on this).
- [x] Cron route runs `register_published_originals(200)` weekly (and can be POSTed by hand).
- [x] `scripts/backfill-match-references.ts`: for each published intake file whose original is purged from R2 but whose Drive file exists (`runs/loupe-published-originals-20260821.csv` logic, re-derived live): download from Drive, `putImmutable('references/{sku}/{intake_id}.{ext}')`, `register_reference(..., storage_key = that key)`. Prints a table; `--dry-run` default.
- [x] Commit: `feat: published originals become matcher references; backfill from Drive (D111)`

---

### Task 9: Catalogue bootstrap

- [x] `AI-Python/loupe-audit/export_catalogue_embeddings.py` — from `bk9/…/siglip2_so400m_512.npz` + `products.csv`: JSONL rows `{sku, handle, title, image_url, filename, full: [1152], crop: [1152]}` (sku from `Variant SKU`; rows without a SKU keep `handle` as sku prefix `HANDLE:`… no: skip them and print the count).
- [x] `scripts/import-catalogue-embeddings.ts <file.jsonl>` — batched inserts into `match_references (source 'catalogue', status 'indexed', indexed_at now(), index_version 'bakeoff-v9')` and `match_embeddings`; idempotent on `(source, image_url)`.
- [x] Verify: `select count(*) from match_embeddings` = 7,332 (or the SKU-bearing subset); `match_search` on one stored vector returns its own SKU at rank 1.
- [x] Commit: `feat: catalogue embeddings imported as index version bakeoff-v9`

---

### Task 10: Restock workflow

**Files:** `supabase/migrations/20260821176000_restock.sql`, `src/lib/shopify/inventory.ts`, `src/app/(shell)/restock/{page.tsx,actions.ts}`, `src/components/restock/RestockScreen.tsx`, `src/lib/publish/publish-product.ts` (supersession), `src/components/console/DraftEditor.tsx` (read-only "Replaces NK845" line).

- [x] **inventory.ts** — `readVariantInventory(client, productId)` (variants with `id`, `title`, `inventoryItem.id`, `inventoryQuantity`), `setAvailableQuantities(client, locationId, items: {inventoryItemId, quantity}[], referenceDocumentUri)` via `inventorySetQuantities(input: {name: "available", reason: "received", ignoreCompareQuantity: true, referenceDocumentUri, quantities: […]})`, `archiveProduct(client, productId)` via `productUpdate(product: {id, status: ARCHIVED})` (API 2026-07). Tests with a fake `graphql`.
- [x] **Restock screen** — rows in `restock` status: photo, chosen SKU with its catalogue thumbnail, the other nine for reference, current Shopify stock per variant (read live, 15 s cache). Step 1 **Confirm it is NK845** (or "Not this one → back to Identify" which re-opens the event: `reopen_identification`). Step 2 choose path: **Restock existing SKU** → quantity inputs per variant prefilled with current; submit → `setAvailableQuantities` → `complete_restock_existing(p_decision, p_quantities, p_actor)` (intake → `restocked`; `register_reference(source 'restock', storage_key = query key)`; `match_events.reference_id`). **Create a new SKU, archive the old** → `begin_new_sku_from_restock(p_decision, p_wants_new_image, p_preset_slug, p_actor)`: intake row → `discovered` with `preset_slug` when a new image is wanted, else → `enhanced` with the original as the selected version (same mechanics as `finalize_manual_image_upload`); the console then shows it in Pending; when the operator creates the draft from it, `product_drafts.supersedes_sku` is set from the decision (console `createDraftFromPhotos` reads `restock_decisions` for the photo); the prefilled stock is old + arrived.
- [x] **Supersession at publish** — in `publishProduct` after the new product is live: `archiveProduct(old)` → `setAvailableQuantities(old variants, 0)` → `record_supersession(p_new_draft, p_old_product_id, p_actor)` (events `product.superseded`). Idempotent: an already-archived product is skipped. Failure here does not un-publish; it is recorded on the decision (`last_error`) and shows in Tracking as attention.
- [x] Step 3 **New generated image?** — for both paths: yes → preset picker built from `PROMPT_CATEGORY_CORES × settingsForCategory` (the same `composeClientPair` slugs the upload screen uses); for restock-existing the generated version, once `enhanced`, is attached to the existing product's media with `productCreateMedia` (one mutation, `src/lib/shopify/media.ts`) — this part is the last sub-step and may ship after the rest.
- [x] Tests: SQL for the three RPCs; unit for inventory input building.
- [x] Commit(s): `feat: Restock — confirm, restock existing or create new SKU and archive the old (D112)`

---

### Task 11: Docs and cron

- [x] `docs/DECISIONS.md`: D110 (identification gate for all sources; never auto-decide), D111 (laptop worker over a bearer API; Loupe owns writes; pgvector search), D112 (restock paths; supersession archives and zeroes the old product).
- [x] `scripts/configure-cron.ts`: `loupe-match-register` weekly; run `npm run cron:configure`.
- [x] `docs/PROGRESS.md` session entry; `CLAUDE.md` "What it does" paragraph gains the Identify gate and the worker.
- [x] Commit: `docs: D110–D112, cron, progress`

---

## Self-review

- Spec coverage: §1 retention — done before this plan (D109). §2 originals to the laptop — Tasks 7 (sync) + 8 (registration) + mapping in sidecar/`match_references`. §3 local heavy processing nightly, VPS light — Tasks 4, 7 (`run-nightly.bat`, Dockerfile fallback), search in Postgres. §4 Drive under the same gate — Task 3 (`discover_intake_file`) + Task 4 (`/api/worker/source`). §5 restock flow — Task 10. §6 self-improving — Task 5 (`confirm_identification`) + Task 10 (`complete_restock_existing`) + nightly embed. §7 order — Tasks 1–11 follow it. §8 statuses — status model table.
- Open items needing the owner: Windows laptop setup (Python, CUDA driver, Task Scheduler), `WORKER_SECRET` in Railway, whether to rent the VPS fallback.
