-- Loupe · Phase 1 · 03 — materials, colours, per-category colour usage

-- Exactly three, fixed. Not free text. The material goes to a Shopify metafield;
-- the six description bullets render from the theme template (docs/DECISIONS.md D6).
create table public.materials (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null unique,
  sort_order  integer     not null default 0,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.materials is
  'Closed set: 304, 316L, Brass. A table rather than an enum only so sort_order and active are editable without a migration.';

-- ---------------------------------------------------------------------------

-- CLAUDE.md: "Normalise on save (trim, collapse spaces, Title Case) ... or the
-- vocabulary rots into Rose Gold / rose gold / Rosegold within a month."
-- Enforced in the database, not the application, because the application is not
-- the only thing that will ever write here.
create or replace function public.normalise_colour_name(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select initcap(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));
$$;

comment on function public.normalise_colour_name(text) is
  'Trim, collapse internal whitespace, Title Case. Rose Gold / rose gold / ROSE  GOLD all collapse to "Rose Gold".';

create table public.colours (
  id           uuid primary key default gen_random_uuid(),
  -- Always stored normalised — see the trigger below. UNIQUE therefore means
  -- "unique after normalisation", which is the property we actually want.
  name         text        not null unique check (length(btrim(name)) > 0),
  created_at   timestamptz not null default now(),
  archived_at  timestamptz
);

create or replace function public.colours_normalise()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.name := public.normalise_colour_name(new.name);
  return new;
end;
$$;

create trigger colours_normalise_name
  before insert or update of name on public.colours
  for each row execute function public.colours_normalise();

comment on table public.colours is
  'Free-text but remembered vocabulary. Names are normalised by trigger on write. An admin merge tool is required, not optional (CLAUDE.md) — that is a later phase.';

-- ---------------------------------------------------------------------------

-- Ranked by usage PER CATEGORY: Necklaces suggest Gold/Silver, Rings suggest
-- Red/White/Green. A single global ranking would surface the wrong colours.
create table public.colour_usage (
  colour_id    uuid        not null references public.colours (id)    on delete cascade,
  category_id  uuid        not null references public.categories (id) on delete cascade,
  usage_count  integer     not null default 0 check (usage_count >= 0),
  last_used_at timestamptz,
  primary key (colour_id, category_id)
);

-- Drives the "most-used colours for this category" picker.
create index colour_usage_category_rank_idx
  on public.colour_usage (category_id, usage_count desc, last_used_at desc nulls last);

-- Supports cascade deletes and colour-merge rewrites from the colour side.
create index colour_usage_colour_id_idx on public.colour_usage (colour_id);
