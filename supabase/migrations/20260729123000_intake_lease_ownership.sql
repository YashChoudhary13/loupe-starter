-- A lease deadline alone is not ownership. Without a compare-and-swap token, a
-- worker that resumes after sweep/reclaim can overwrite the newer worker's
-- state. Give every intake claim a UUID capability and require it when a worker
-- records a completed failure.

alter table public.intake_files
  add column if not exists lease_token uuid;

-- Existing Phase 3A rows predate ownership tokens. No such claim can safely be
-- completed, so return it to the ready queue and make the recovery auditable.
with reset as (
  update public.intake_files
     set status            = 'discovered',
         lease_token       = null,
         lease_expires_at  = null,
         next_attempt_at   = now()
   where status = 'enhancing'
  returning id, attempts, lease_expires_at
)
insert into public.events (entity_type, entity_id, event, detail, actor)
select
  'intake_file',
  id,
  'intake.lease_invalidated',
  jsonb_build_object(
    'attempts_completed', attempts,
    'reason', 'Phase 3A lease ownership upgrade',
    'rediscovered_at', now()
  ),
  'migration'
from reset;

update public.intake_files
   set lease_token = null,
       lease_expires_at = null
 where status <> 'enhancing'
   and (lease_token is not null or lease_expires_at is not null);

do $migration$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.intake_files'::regclass
       and conname = 'intake_files_phase_3a_lease_pair'
  ) then
    alter table public.intake_files
      add constraint intake_files_phase_3a_lease_pair check (
        (lease_token is null) = (lease_expires_at is null)
      );
  end if;
end
$migration$;

-- Return shape now includes the ownership token, so PostgreSQL requires a drop
-- before replacement.
drop function if exists public.claim_intake_file(integer);

create function public.claim_intake_file(
  p_lease_seconds integer default 900
)
returns table (
  id               uuid,
  drive_file_id    text,
  filename         text,
  drive_md5        text,
  bytes            bigint,
  mime_type        text,
  status           public.intake_status,
  attempts         integer,
  lease_token      uuid,
  lease_expires_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_lease_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_intake_file: p_lease_seconds must be positive, got %',
      coalesce(p_lease_seconds::text, '<null>') using errcode = '22023';
  end if;

  with candidate as (
    select f.id
      from public.intake_files as f
     where f.status = 'discovered'
       and f.next_attempt_at <= now()
     order by f.next_attempt_at, f.discovered_at, f.id
     limit 1
       for update skip locked
  )
  update public.intake_files as f
     set status           = 'enhancing',
         lease_token      = v_lease_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from candidate as c
   where f.id = c.id
  returning f.* into v_file;

  if not found then
    return;
  end if;

  insert into public.events (entity_type, entity_id, event, detail)
  values (
    'intake_file',
    v_file.id,
    'intake.claimed',
    jsonb_build_object(
      'attempts_completed', v_file.attempts,
      'lease_expires_at', v_file.lease_expires_at
    )
  );

  return query
  select
    v_file.id,
    v_file.drive_file_id,
    v_file.filename,
    v_file.drive_md5,
    v_file.bytes,
    v_file.mime_type,
    v_file.status,
    v_file.attempts,
    v_file.lease_token,
    v_file.lease_expires_at;
end;
$$;

comment on function public.claim_intake_file(integer) is
  'Claims at most one due discovered intake row using FOR UPDATE SKIP LOCKED. Returns a UUID ownership token, sets status=enhancing, and deliberately does not increment attempts; failure completion must compare-and-swap that token.';

-- Remove the unsafe, tokenless completion signature deployed by the first
-- Phase 3A migration before creating the ownership-aware one.
drop function if exists public.record_intake_failure(
  uuid,
  text,
  text,
  public.error_class,
  text,
  text
);

create or replace function public.record_intake_failure(
  p_intake_file_id uuid,
  p_lease_token    uuid,
  p_error          text,
  p_error_code     text,
  p_error_class    public.error_class,
  p_error_detail   text default null,
  p_source         text default null
)
returns table (
  id              uuid,
  status          public.intake_status,
  attempts        integer,
  next_attempt_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file         public.intake_files%rowtype;
  v_attempts     integer;
  v_status       public.intake_status;
  v_next_attempt timestamptz;
  v_error        text;
  v_event        text;
begin
  if p_lease_token is null then
    raise exception 'record_intake_failure: p_lease_token must not be null'
      using errcode = '22023';
  end if;

  if p_error_class is null then
    raise exception 'record_intake_failure: p_error_class must be retryable or permanent'
      using errcode = '22023';
  end if;

  select f.*
    into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
     and f.status = 'enhancing'
     and f.lease_token = p_lease_token
     and f.lease_expires_at > now()
     for update;

  if not found then
    raise exception 'record_intake_failure: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  v_attempts := v_file.attempts + 1;
  v_error := left(coalesce(nullif(btrim(p_error), ''), 'Unknown intake failure'), 4000);

  if p_error_class = 'permanent' or v_attempts >= 5 then
    v_status := 'failed';
    v_next_attempt := now();
    v_event := 'intake.failed';
  else
    v_status := 'discovered';
    v_next_attempt := now() + case v_attempts
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      when 3 then interval '20 minutes'
      when 4 then interval '1 hour'
    end;
    v_event := 'intake.retry_scheduled';
  end if;

  update public.intake_files as f
     set status            = v_status,
         attempts          = v_attempts,
         last_error        = v_error,
         last_error_code   = p_error_code,
         last_error_detail = p_error_detail,
         error_class       = p_error_class,
         lease_token       = null,
         lease_expires_at  = null,
         next_attempt_at   = v_next_attempt
   where f.id = p_intake_file_id
     and f.lease_token = p_lease_token;

  if not found then
    raise exception 'record_intake_failure: lease for intake_file % changed during completion',
      p_intake_file_id using errcode = '40001';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    v_event,
    jsonb_strip_nulls(jsonb_build_object(
      'error', v_error,
      'code', p_error_code,
      'error_class', p_error_class,
      'raw_detail', p_error_detail,
      'attempts', v_attempts,
      'next_attempt_at', case when v_status = 'discovered' then v_next_attempt else null end,
      'retry_budget_exhausted', p_error_class = 'retryable' and v_attempts >= 5,
      'source', p_source
    )),
    p_source
  );

  return query
  select p_intake_file_id, v_status, v_attempts, v_next_attempt;
end;
$$;

comment on function public.record_intake_failure(
  uuid,
  uuid,
  text,
  text,
  public.error_class,
  text,
  text
) is
  'Compare-and-swap completion for the current unexpired intake lease. Atomically records one completed attempt and event; stale workers are rejected. Permanent errors fail immediately, retryable attempt 5 is terminal.';

create or replace function public.sweep_expired_intake_leases(
  p_source text default 'lease-sweeper'
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with expired as (
    select f.id, f.lease_expires_at
      from public.intake_files as f
     where f.status = 'enhancing'
       and f.lease_expires_at <= now()
       for update skip locked
  ),
  swept as (
    update public.intake_files as f
       set status            = 'discovered',
           lease_token       = null,
           lease_expires_at  = null,
           next_attempt_at   = now()
      from expired as e
     where f.id = e.id
    returning f.id, f.attempts, e.lease_expires_at as expired_at
  ),
  logged as (
    insert into public.events (entity_type, entity_id, event, detail, actor)
    select
      'intake_file',
      s.id,
      'intake.lease_expired',
      jsonb_build_object(
        'attempts_completed', s.attempts,
        'expired_at', s.expired_at,
        'rediscovered_at', now(),
        'source', p_source
      ),
      p_source
      from swept as s
    returning 1
  )
  select count(*)::integer into v_count from logged;

  return v_count;
end;
$$;

comment on function public.sweep_expired_intake_leases(text) is
  'Returns every expired enhancing lease to discovered, clears its UUID ownership and deadline, makes it due now, preserves completed attempts, and writes exactly one intake.lease_expired event per row.';

revoke all on function public.claim_intake_file(integer)
  from public, anon, authenticated;
revoke all on function public.record_intake_failure(
  uuid,
  uuid,
  text,
  text,
  public.error_class,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.sweep_expired_intake_leases(text)
  from public, anon, authenticated;

grant execute on function public.claim_intake_file(integer)
  to service_role;
grant execute on function public.record_intake_failure(
  uuid,
  uuid,
  text,
  text,
  public.error_class,
  text,
  text
) to service_role;
grant execute on function public.sweep_expired_intake_leases(text)
  to service_role;
