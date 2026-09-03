-- D121 — operator-selectable pipeline models.
--
-- One tiny key-value table so the /models console section can move a pipeline
-- stage onto a different curated model without a deploy. Keys are the four
-- stage names; values are provider-qualified OpenRouter slugs. Validation
-- against the curated lists happens in application code, which is where those
-- lists live; the table only guards shape.
--
-- RLS enabled with zero policies, like every other table: the browser can
-- touch nothing, and only the service role (server actions) reads or writes.

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);

alter table public.app_config enable row level security;

comment on table public.app_config is
  'Small operator-editable configuration (D121). Currently the four pipeline model choices; values validated in application code against the curated model lists.';
