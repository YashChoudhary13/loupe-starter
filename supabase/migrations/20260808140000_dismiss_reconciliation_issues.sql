-- Let an operator dismiss a reconciliation finding they have judged correct.
--
-- WHY IT CANNOT BE A DELETE
--
-- `shopify_reconciliation_issues` rows are derived, not authored: every run
-- recreates them from scratch. Deleting a row clears Tracking until 03:00 IST
-- and then the same finding reappears, which is worse than not offering the
-- button at all.
--
-- So a dismissal is a separate, durable record of a JUDGEMENT, keyed on the
-- drift itself rather than on the row that reported it:
--
--     (product_draft_id, code, field, actual)
--
-- Including `actual` is the load-bearing part. "I accept that AK089 now carries
-- RS229" is a different statement from "never tell me about AK089's SKU again".
-- If the value changes again — a third SKU, a different colour — that is new
-- drift and it comes back. A dismissal silences a fact, never a subject.
--
-- `expected` is deliberately NOT in the key. It is derived from the Loupe draft,
-- so an operator editing the draft would otherwise silently revive a dismissal
-- they had already made about the Shopify side.

create table if not exists public.shopify_reconciliation_dismissals (
  id                uuid primary key default gen_random_uuid(),
  product_draft_id  uuid not null references public.product_drafts(id) on delete cascade,
  code              text not null,
  field             text not null,
  -- jsonb, matching shopify_reconciliation_issues.actual, so `null` and the
  -- string "null" cannot collide and comparison is structural rather than
  -- dependent on key order in a serialised copy.
  actual            jsonb,
  reason            text,
  dismissed_by      text not null,
  dismissed_at      timestamptz not null default now()
);

comment on table public.shopify_reconciliation_dismissals is
  'Operator judgements that a specific reconciliation finding is acceptable. Keyed on the observed value, so the finding returns if that value changes again.';

-- `actual` is nullable, and NULL is never equal to NULL in a plain UNIQUE
-- constraint — two dismissals of the same null-valued finding would both be
-- accepted. Coalescing into the index makes the uniqueness real.
create unique index if not exists shopify_reconciliation_dismissals_unique
  on public.shopify_reconciliation_dismissals (
    product_draft_id, code, field, coalesce(actual, 'null'::jsonb)
  );

create index if not exists shopify_reconciliation_dismissals_draft_idx
  on public.shopify_reconciliation_dismissals (product_draft_id);

alter table public.shopify_reconciliation_dismissals enable row level security;

-- Phase 1 convention: RLS on with zero policies is a default deny. Only
-- service_role, reachable solely through src/lib/supabase/server.ts, can read
-- or write this table.

-- ---------------------------------------------------------------------------

create or replace function public.dismiss_reconciliation_issue(
  p_issue_id bigint,
  p_actor    text,
  p_reason   text default null
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_issue public.shopify_reconciliation_issues%rowtype;
  v_id    uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'dismiss_reconciliation_issue: actor is required'
      using errcode = '22023';
  end if;

  select * into v_issue
    from public.shopify_reconciliation_issues
   where id = p_issue_id;
  if not found then
    raise exception 'dismiss_reconciliation_issue: no issue %', p_issue_id
      using errcode = '22023',
            hint = 'The finding may have been replaced by a newer reconciliation run. Refresh Tracking.';
  end if;

  insert into public.shopify_reconciliation_dismissals (
    product_draft_id, code, field, actual, reason, dismissed_by
  )
  values (
    v_issue.product_draft_id, v_issue.code, v_issue.field, v_issue.actual,
    nullif(btrim(coalesce(p_reason, '')), ''), p_actor
  )
  -- Two operators dismissing the same finding is agreement, not a conflict.
  on conflict (product_draft_id, code, field, coalesce(actual, 'null'::jsonb))
  do update set dismissed_at = now(), dismissed_by = excluded.dismissed_by
  returning id into v_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'product_draft',
    v_issue.product_draft_id,
    'reconciliation.issue_dismissed',
    jsonb_build_object(
      'code', v_issue.code,
      'field', v_issue.field,
      'actual', v_issue.actual,
      'message', v_issue.message,
      'reason', nullif(btrim(coalesce(p_reason, '')), '')
    ),
    p_actor
  );

  return v_id;
end;
$$;

comment on function public.dismiss_reconciliation_issue(bigint, text, text) is
  'Records that an operator accepts one reconciliation finding. Durable across runs; the finding returns if the observed value changes.';

-- ---------------------------------------------------------------------------

create or replace function public.restore_reconciliation_dismissal(
  p_dismissal_id uuid,
  p_actor        text
)
returns boolean
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.shopify_reconciliation_dismissals%rowtype;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'restore_reconciliation_dismissal: actor is required'
      using errcode = '22023';
  end if;

  delete from public.shopify_reconciliation_dismissals
   where id = p_dismissal_id
  returning * into v_row;
  if not found then
    return false;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'product_draft',
    v_row.product_draft_id,
    'reconciliation.dismissal_restored',
    jsonb_build_object('code', v_row.code, 'field', v_row.field, 'actual', v_row.actual),
    p_actor
  );

  return true;
end;
$$;

comment on function public.restore_reconciliation_dismissal(uuid, text) is
  'Undoes a dismissal. The finding reappears on the next reconciliation run, or immediately if the current run already reported it.';

revoke all on function public.dismiss_reconciliation_issue(bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.restore_reconciliation_dismissal(uuid, text)
  from public, anon, authenticated;
grant execute on function public.dismiss_reconciliation_issue(bigint, text, text) to service_role;
grant execute on function public.restore_reconciliation_dismissal(uuid, text) to service_role;
