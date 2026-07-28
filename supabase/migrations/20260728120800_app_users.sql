-- Loupe · Phase 1 · 09 — app_users
--
-- The allowlist only. Authentication itself is Phase 4; this table exists now so
-- the schema is complete and so there is somewhere for the first admin to live.
-- CLAUDE.md hard rule 7: auth is Google sign-in restricted to the company domain,
-- not a shared password. Membership of this table is the second gate.

create type public.app_role as enum ('admin', 'operator');

create table public.app_users (
  id           uuid        primary key default gen_random_uuid(),
  -- Stored lowercase by trigger, so UNIQUE genuinely means one row per human.
  email        text        not null unique check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  name         text,
  role         app_role    not null default 'operator',
  -- Revoking access must not delete the audit trail, so deactivate, never delete.
  active       boolean     not null default true,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function public.app_users_normalise()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

create trigger app_users_normalise_email
  before insert or update of email on public.app_users
  for each row execute function public.app_users_normalise();

create trigger app_users_set_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

comment on table public.app_users is
  'Access allowlist. Phase 4 checks Google sign-in against this table. Deactivate (active = false) rather than deleting — events.actor references these people by email and that history must survive.';
comment on column public.app_users.role is
  'operator: queue, grouping, publish. admin: additionally prompts, colour merges and this table.';

-- Phase 4 will look people up by email on every request, on the live rows only.
create index app_users_active_email_idx on public.app_users (email) where active;
