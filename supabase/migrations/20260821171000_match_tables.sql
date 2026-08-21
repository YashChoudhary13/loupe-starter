-- D110/D111: the SKU matcher's tables.
--
-- Loupe owns every row here. The Windows worker only ever reaches them through
-- the RPCs of the next migration, called by /api/worker/* with a lease token.
-- docs/superpowers/plans/2026-08-21-sku-matching-implementation.md describes
-- the lifecycle each status column tracks.

create extension if not exists vector with schema extensions;

-- One row per identification shown to a human: the exact query bytes, the exact
-- ten candidates, and what the human decided. One row = one labelled example.
create table public.match_events (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  surface           text not null check (surface in ('upload', 'drive', 'identify')),
  intake_file_id    uuid references public.intake_files (id) on delete set null,
  -- R2 key of the bytes the worker embeds, or 'drive:<file id>' for a Drive
  -- photograph fetched through Loupe. Never purged (D109).
  query_storage_key text not null,
  query_sha256      text,
  status            text not null default 'queued' check (status in ('queued', 'matched', 'decided')),
  model             text,
  index_version     text,
  crop_box          integer[],
  -- [{"rank":1,"sku":"NK845","handle":"necklace-845","score":0.71}, ...] exactly as shown.
  candidates        jsonb,
  matched_at        timestamptz,
  latency_ms        integer,
  decided_at        timestamptz,
  decided_by        text,
  decision          text check (decision in ('new_product', 'restock', 'confirmed', 'none_of_these', 'skipped')),
  chosen_sku        text,
  chosen_rank       smallint,
  -- Set once this photograph itself became a reference (restock or confirmed identify).
  reference_id      uuid,
  constraint match_events_decision_is_attributed
    check (decision is null or (decided_at is not null and decided_by is not null)),
  constraint match_events_pick_names_sku
    check (decision is null or decision not in ('restock', 'confirmed') or chosen_sku is not null)
);
comment on table public.match_events is
  'Every identification shown to a human: query, the ten candidates exactly as shown, and the decision. Append-only; the matcher''s training data (D110).';
create index match_events_intake_idx on public.match_events (intake_file_id) where intake_file_id is not null;
create index match_events_status_idx on public.match_events (status, created_at);
create index match_events_chosen_idx on public.match_events (chosen_sku) where chosen_sku is not null;

-- Every image the matcher may compare against, with its journey to the laptop
-- and into the index.
create table public.match_references (
  id              uuid primary key default gen_random_uuid(),
  sku             text not null,
  handle          text,
  title           text,
  image_url       text,         -- public CDN URL (catalogue rows)
  storage_key     text,         -- R2 key (Loupe rows); never purged (D109)
  sha256          text,
  source          text not null check (source in ('catalogue', 'loupe_original', 'restock', 'identify_confirmed')),
  intake_file_id  uuid references public.intake_files (id) on delete set null,
  match_event_id  uuid references public.match_events (id) on delete set null,
  status          text not null default 'pending_sync'
                  check (status in ('pending_sync', 'synced', 'queued', 'indexed', 'failed', 'retired')),
  added_at        timestamptz not null default now(),
  added_by        text,
  synced_at       timestamptz,
  local_path      text,         -- where the laptop keeps the bytes
  embedded_at     timestamptz,
  indexed_at      timestamptz,
  index_version   text,
  last_error      text,
  retired_at      timestamptz,  -- a label later found wrong is retired, never deleted
  constraint match_references_has_bytes check (image_url is not null or storage_key is not null)
);
comment on table public.match_references is
  'Reference images the matcher compares against: the legacy catalogue, every published original, restock photographs and confirmed identifications. Status tracks sync to the laptop and entry into the index (D111).';
create unique index match_references_one_per_intake on public.match_references (intake_file_id) where intake_file_id is not null;
create unique index match_references_one_per_url on public.match_references (image_url) where image_url is not null;
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
comment on table public.match_embeddings is
  'SigLIP2-so400m/512 embeddings, L2-normalised, one per reference view. Searched exactly (no ANN index) — thousands of rows, milliseconds.';

-- The worker queue: one row per unit of work, leased with a UUID token (hard rule 6).
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
comment on table public.match_jobs is
  'Work for the vision worker: sync a reference to the laptop, embed it, or embed an identification query. Claimed with SKIP LOCKED and a lease token through claim_match_job().';
create index match_jobs_queue_idx on public.match_jobs (kind, created_at) where status = 'queued';
create index match_jobs_lease_idx on public.match_jobs (lease_expires_at) where status = 'claimed';
create index match_jobs_event_idx on public.match_jobs (match_event_id) where match_event_id is not null;

create table public.match_workers (
  worker_id    text primary key,
  device       text,
  kinds        text[],
  version      text,
  last_seen_at timestamptz not null default now()
);
comment on table public.match_workers is
  'Heartbeats of vision workers. The Identify screen reads last_seen_at to say whether a match is coming.';

-- A confirmed restock and how it was resolved.
create table public.restock_decisions (
  id                     uuid primary key default gen_random_uuid(),
  intake_file_id         uuid not null unique references public.intake_files (id) on delete cascade,
  match_event_id         uuid not null references public.match_events (id),
  sku                    text not null,
  old_shopify_product_id text,
  path                   text check (path in ('restock_existing', 'new_sku_archive_old')),
  -- [{"variant_id":"gid://…","inventory_item_id":"gid://…","label":"Gold","before":3,"after":15}]
  quantities             jsonb,
  new_draft_id           uuid references public.product_drafts (id) on delete set null,
  wants_new_image        boolean,
  preset_slug            text,
  status                 text not null default 'pending'
                         check (status in ('pending', 'inventory_set', 'draft_created', 'completed', 'failed')),
  created_at             timestamptz not null default now(),
  created_by             text not null,
  completed_at           timestamptz,
  last_error             text
);
comment on table public.restock_decisions is
  'One per photograph an operator confirmed as a restock: which SKU, which path (restock the existing product or create a new SKU and archive the old), and the stock numbers applied (D112).';

alter table public.product_drafts add column supersedes_sku text;
comment on column public.product_drafts.supersedes_sku is
  'Set when this draft replaces an existing product after a restock decision: at publish the old product is archived and its inventory zeroed (D112).';

alter table public.match_events      enable row level security;
alter table public.match_references  enable row level security;
alter table public.match_embeddings  enable row level security;
alter table public.match_jobs        enable row level security;
alter table public.match_workers     enable row level security;
alter table public.restock_decisions enable row level security;
