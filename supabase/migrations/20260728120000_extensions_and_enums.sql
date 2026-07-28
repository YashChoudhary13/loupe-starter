-- Loupe · Phase 1 · 01 — extensions, shared trigger helper, closed vocabularies
--
-- Closed vocabularies are Postgres enums rather than text+CHECK. Every one of these
-- sets is fully enumerated in docs/phases/PHASE-1-foundation.md, they generate proper
-- TypeScript union types via `supabase gen types`, and widening one later is a
-- one-line ALTER TYPE ... ADD VALUE. See docs/DECISIONS.md D10.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- Keeps updated_at honest without trusting the application to remember.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger helper: stamps updated_at on UPDATE.';

-- The intake lifecycle. `duplicate` and `skipped` are terminal operator decisions;
-- `failed` is terminal only after the retry budget in CLAUDE.md hard rule 4 is spent.
create type public.intake_status as enum (
  'discovered',
  'enhancing',
  'enhanced',
  'grouped',
  'published',
  'failed',
  'duplicate',
  'skipped'
);

-- CLAUDE.md hard rule 4: permanent errors skip retries entirely.
create type public.error_class as enum (
  'retryable',
  'permanent'
);

-- CLAUDE.md hard rule 2: publishing is idempotent by handle, and `publishing`
-- is the crash-visible intermediate state.
create type public.draft_status as enum (
  'assembling',
  'publishing',
  'published',
  'failed'
);

-- CLAUDE.md: the original is immutable and kept forever; everything else derives from it.
create type public.image_kind as enum (
  'original',
  'generated'
);
