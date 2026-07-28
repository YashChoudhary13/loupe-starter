-- Loupe · Phase 1 · 06 — image_versions
--
-- The original is immutable and kept forever; every version derives from it.
-- Originals live permanently in Google Drive, R2 caches one only while the item
-- is in the queue (CLAUDE.md · Storage).

create table public.image_versions (
  id                uuid        primary key default gen_random_uuid(),
  intake_file_id    uuid        not null references public.intake_files (id) on delete cascade,
  version_no        integer     not null check (version_no >= 0),
  kind              image_kind  not null,

  -- R2 object key. originals/{intake_file_id}.jpg and versions/{intake_file_id}/v{n}.jpg
  storage_key       text        not null check (length(btrim(storage_key)) > 0),
  width             integer     check (width is null or width > 0),
  height            integer     check (height is null or height > 0),

  -- The prompt is configuration, not code — it lives in the prompts table and is
  -- versioned. The exact text used is copied here so a published product can
  -- always be traced back to the words that produced it, even if the prompt row
  -- is later edited.
  prompt_text       text,
  model             text,
  cost_usd          numeric(10, 4) check (cost_usd is null or cost_usd >= 0),
  parent_version_id uuid        references public.image_versions (id) on delete set null,

  is_selected       boolean     not null default false,
  -- ~50 KB thumbnail beside every version. The queue grid uses thumbnails, never
  -- full images.
  thumb_key         text,
  created_at        timestamptz not null default now(),

  unique (intake_file_id, version_no),

  -- An original is the photographer's file: it has no prompt, no model, no cost
  -- and no parent. A generated version must record what produced it.
  constraint image_versions_original_is_pristine check (
    kind <> 'original'
    or (prompt_text is null and model is null and cost_usd is null and parent_version_id is null)
  ),
  constraint image_versions_generated_is_attributed check (
    kind <> 'generated' or (prompt_text is not null and model is not null)
  ),
  constraint image_versions_no_self_parent check (parent_version_id is distinct from id)
);

comment on table public.image_versions is
  'Every rendition of a source photo, including the untouched original (kind = original, version_no = 0). Rows are append-only in practice; correcting an image means adding a version, never editing one.';
comment on column public.image_versions.cost_usd is
  'USD, 4dp — this is a vendor cost, not customer money, so it is not in paise. Tested cost is about $0.07/image.';

-- Exactly one selected version per source file: the one that gets published.
create unique index image_versions_one_selected_per_file
  on public.image_versions (intake_file_id)
  where is_selected;

create index image_versions_intake_file_id_idx on public.image_versions (intake_file_id);
create index image_versions_parent_version_id_idx
  on public.image_versions (parent_version_id) where parent_version_id is not null;
