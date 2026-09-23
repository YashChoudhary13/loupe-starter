-- Home dashboard (D137): the last known state of each health probe, so a light can say "red since 03:12".
-- Only a CHANGE is written; every change also writes an events row (home.probe_changed).
create table public.home_probe_state (
  probe_key text primary key check (probe_key ~ '^[a-z0-9_-]{1,40}$'),
  status text not null check (status in ('green','amber','red')),
  detail text not null default '',
  since timestamptz not null default now(),
  checked_at timestamptz not null default now()
);
alter table public.home_probe_state enable row level security;
revoke all on public.home_probe_state from public, anon, authenticated;
grant select, insert, update, delete on public.home_probe_state to service_role;
comment on table public.home_probe_state is 'One row per Home health probe: current status and when it last changed. Written only by the server on a change.';
