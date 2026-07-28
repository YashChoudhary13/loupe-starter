-- Loupe · Phase 1 · 05 — intake_files
--
-- CLAUDE.md hard rule 3: the Drive folder is an inbox, not a state machine.
-- The row is inserted BEFORE any work is attempted. A file's presence in RAW
-- never means "unprocessed" — this table says what is true.

create table public.intake_files (
  id                uuid           primary key default gen_random_uuid(),

  -- UNIQUE is what makes re-scanning the entire Drive folder always safe.
  drive_file_id     text           not null unique,
  filename          text           not null,
  drive_md5         text,
  bytes             bigint         check (bytes is null or bytes >= 0),

  status            intake_status  not null default 'discovered',

  -- Bounded retries: 5 attempts with backoff (0, 1m, 5m, 20m, 1h), then a human
  -- looks. Never infinite — one corrupt HEIC would retry forever and burn credit.
  attempts          integer        not null default 0 check (attempts >= 0),
  last_error        text,
  last_error_code   text,
  error_class       error_class,

  -- Crashed workers self-heal via leases (hard rule 6). A worker claiming a row
  -- sets this; a sweeper returns expired leases to the queue.
  lease_expires_at  timestamptz,

  -- Perceptual hash for duplicate detection. Fixed algorithm, warns only, never
  -- blocks or decides (docs/DECISIONS.md D8).
  phash             text,

  discovered_at     timestamptz    not null default now(),
  enhanced_at       timestamptz,
  grouped_at        timestamptz,
  published_at      timestamptz,

  product_draft_id  uuid           references public.product_drafts (id) on delete set null,

  created_at        timestamptz    not null default now(),
  updated_at        timestamptz    not null default now(),

  -- A failed row must say why, and say whether retrying could ever help.
  constraint intake_files_failure_is_explained check (
    status <> 'failed' or (last_error is not null and error_class is not null)
  ),
  -- Grouped or later means it belongs to a draft.
  constraint intake_files_grouped_has_draft check (
    status not in ('grouped', 'published') or product_draft_id is not null
  )
);

comment on table public.intake_files is
  'One row per file discovered in the flat Drive RAW folder. Inserted before any work is attempted; drive_file_id is UNIQUE so a full re-scan is idempotent.';
comment on column public.intake_files.lease_expires_at is
  'Set by the worker that claims this row. A sweeper returns expired leases to the queue so one crash cannot strand a file forever in a status that looks busy.';

-- --- Specified indexes ------------------------------------------------------

-- "What has stalled" — the tracking page's main query. Age-based, not status-based.
create index intake_files_status_discovered_at_idx
  on public.intake_files (status, discovered_at);

-- The lease sweeper's only query. Partial: enhancing is the sole leased state,
-- so this index stays tiny however large the table grows.
create index intake_files_expired_lease_idx
  on public.intake_files (lease_expires_at)
  where status = 'enhancing';

-- Perceptual-hash duplicate lookup.
create index intake_files_phash_idx
  on public.intake_files (phash)
  where phash is not null;

-- Supports "which files belong to this draft".
create index intake_files_product_draft_id_idx
  on public.intake_files (product_draft_id)
  where product_draft_id is not null;

create trigger intake_files_set_updated_at
  before update on public.intake_files
  for each row execute function public.set_updated_at();
