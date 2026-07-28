-- Loupe · Phase 1 · 08 — prompts and the event log

-- "The enhancement prompt is configuration, not code. It lives in the prompts
-- table, is editable in the UI, and is versioned. It must never be hardcoded —
-- replacing five ChatGPT tabs with one hardcoded string just moves the problem."
create table public.prompts (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  body        text        not null check (length(btrim(body)) > 0),
  is_default  boolean     not null default false,
  created_by  text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

comment on table public.prompts is
  'Versioned enhancement prompts. Editing a prompt means inserting a new row, never updating body in place — image_versions.prompt_text records the exact text used, so history must stay intact.';

-- At most one live default. Archived rows are excluded so retiring a default and
-- promoting a replacement is a normal two-statement transaction.
create unique index prompts_one_live_default
  on public.prompts (is_default)
  where is_default and archived_at is null;

create index prompts_live_idx on public.prompts (name) where archived_at is null;

-- ---------------------------------------------------------------------------

-- "Every state transition writes a row to events — every listing must trace back
-- to its source photo, prompt and version." (CLAUDE.md conventions)
create table public.events (
  id          bigint generated always as identity primary key,
  entity_type text        not null check (length(btrim(entity_type)) > 0),
  entity_id   uuid,
  event       text        not null check (length(btrim(event)) > 0),
  detail      jsonb       not null default '{}'::jsonb,
  actor       text,
  created_at  timestamptz not null default now()
);

comment on table public.events is
  'Append-only audit trail. entity_type is free text rather than an enum because it must be able to name things this schema does not model yet; entity_id is nullable so system-level events (a sweeper run, a Drive scan) can be recorded without inventing an entity.';

-- Specified index: the per-entity history query.
create index events_entity_idx on public.events (entity_type, entity_id, created_at desc);
-- The tracking page's global "what just happened" feed.
create index events_created_at_idx on public.events (created_at desc);
