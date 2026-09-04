-- D122 — one-click operator workflows (/workflows).
--
-- A run is a durable record of one press of a workflow's Run button: which
-- steps it has, what each is doing right now, and what it found. The row is
-- updated in place while the run executes so every operator's browser can
-- follow it, and it survives a page reload or a Loupe restart (a run left
-- "running" past its heartbeat is reported as failed by the reader).
--
-- Exactly one running row per workflow: pressing Run twice, or two operators
-- pressing it together, joins the run already in flight instead of starting a
-- second full-store read. Different workflows may run at the same time.
--
-- RLS enabled with zero policies, like every other table.

create table if not exists public.workflow_runs (
  id          uuid primary key default gen_random_uuid(),
  workflow    text not null check (length(btrim(workflow)) > 0),
  status      text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_by  text not null check (length(btrim(started_by)) > 0),
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz,
  steps       jsonb not null default '[]'::jsonb,
  summary     text,
  error       text,
  log         jsonb not null default '[]'::jsonb,
  result      jsonb not null default '{}'::jsonb
);

create unique index if not exists workflow_runs_one_running
  on public.workflow_runs (workflow) where status = 'running';

create index if not exists workflow_runs_recent
  on public.workflow_runs (workflow, started_at desc);

alter table public.workflow_runs enable row level security;

comment on table public.workflow_runs is
  'One row per press of a /workflows Run button (D122). steps/log/result are written in place while the run executes; a single running row per workflow is enforced by a partial unique index.';
