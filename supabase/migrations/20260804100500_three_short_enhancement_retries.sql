-- Operator policy, 2026-08-04:
--
--   initial attempt
--   retry 1 after 1 minute
--   retry 2 after 2 minutes
--   retry 3 after 5 minutes
--   then show a terminal error
--
-- `attempts` counts completed attempts, so attempt 4 is terminal. Apply the
-- same bounded policy to structured description, image generation and manual
-- redo work. Existing queued rows are shortened to the new deadlines; they are
-- never made later by this migration.

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

  v_attempts := least(4, v_file.attempts + 1);
  v_error := left(coalesce(nullif(btrim(p_error), ''), 'Unknown intake failure'), 4000);

  if p_error_class = 'permanent' or v_attempts >= 4 then
    v_status := 'failed';
    v_next_attempt := now();
    v_event := 'intake.failed';
  else
    v_status := 'discovered';
    v_next_attempt := now() + case v_attempts
      when 1 then interval '1 minute'
      when 2 then interval '2 minutes'
      when 3 then interval '5 minutes'
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
      'retry_budget_exhausted', p_error_class = 'retryable' and v_attempts >= 4,
      'source', p_source
    )),
    p_source
  );

  return query
  select p_intake_file_id, v_status, v_attempts, v_next_attempt;
end;
$$;

comment on function public.record_intake_failure(
  uuid, uuid, text, text, public.error_class, text, text
) is
  'Fenced intake failure completion. The initial attempt gets exactly three automatic retries after 1m, 2m and 5m; failed attempt 4 is terminal and remains visible for a human retry.';

create or replace function public.record_description_failure(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_error text,
  p_error_code text,
  p_error_detail text default null,
  p_source text default 'enhancement-worker'
)
returns table (
  id uuid,
  status public.intake_status,
  attempts integer,
  next_attempt_at timestamptz,
  proceed_without_description boolean,
  presentation_class public.presentation_class,
  presentation_fallback boolean,
  presentation_fallback_reason text
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_attempts integer;
  v_error text;
  v_next_attempt timestamptz;
  v_cost_ceiling boolean;
  v_proceed boolean;
  v_terminal boolean;
begin
  select f.*
    into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
     and f.status = 'enhancing'
     and f.lease_token = p_lease_token
     and f.lease_expires_at > now()
     for update;

  if not found then
    raise exception 'record_description_failure: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  v_attempts := least(4, v_file.attempts + 1);
  v_error := left(
    coalesce(nullif(btrim(p_error), ''), 'The jewellery description could not be generated.'),
    4000
  );
  -- A configured cost ceiling is a deliberate quality/cost policy, not an
  -- unavailable provider. Preserve the existing immediate fallback for it.
  v_cost_ceiling := p_error_code = 'description_cost_ceiling_exceeded';
  v_proceed := v_cost_ceiling;
  v_terminal := not v_proceed and v_attempts >= 4;
  v_next_attempt := case
    when v_proceed or v_terminal then now()
    when v_attempts = 1 then now() + interval '1 minute'
    when v_attempts = 2 then now() + interval '2 minutes'
    when v_attempts = 3 then now() + interval '5 minutes'
  end;

  update public.intake_files as f
     set status                       = case
           when v_terminal then 'failed'::public.intake_status
           when v_proceed then 'enhancing'::public.intake_status
           else 'discovered'::public.intake_status
         end,
         attempts                     = v_attempts,
         next_attempt_at              = v_next_attempt,
         lease_token                  = case when v_proceed then f.lease_token else null end,
         lease_expires_at             = case when v_proceed then f.lease_expires_at else null end,
         description_error            = v_error,
         description_error_code       = p_error_code,
         description_error_detail     = p_error_detail,
         description_missing_at       = case when v_proceed then now() else null end,
         presentation_class           = case
           when v_proceed and f.presentation_class is null
             then 'flat-curve'::public.presentation_class
           else f.presentation_class
         end,
         presentation_fallback        = case
           when v_proceed and f.presentation_class is null then true
           else f.presentation_fallback
         end,
         presentation_fallback_reason = case
           when v_proceed and f.presentation_class is null
             then left(coalesce(nullif(btrim(p_error_code), ''), 'description_failed'), 200)
           else f.presentation_fallback_reason
         end,
         last_error                    = case when v_proceed then f.last_error else v_error end,
         last_error_code               = case when v_proceed then f.last_error_code else p_error_code end,
         last_error_detail             = case when v_proceed then f.last_error_detail else p_error_detail end,
         error_class                   = case
           when v_proceed then f.error_class
           else 'retryable'::public.error_class
         end
   where f.id = p_intake_file_id
     and f.lease_token = p_lease_token
  returning f.* into v_file;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    case
      when v_terminal then 'intake.failed'
      when v_proceed then 'description.missing'
      else 'description.retry_scheduled'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'error', v_error,
      'code', p_error_code,
      'raw_detail', p_error_detail,
      'attempts', v_attempts,
      'next_attempt_at', case when not v_proceed and not v_terminal then v_next_attempt else null end,
      'proceed_without_description', v_proceed,
      'retry_budget_exhausted', v_terminal,
      'cost_ceiling_exceeded', v_cost_ceiling,
      'presentation_class', case when v_proceed then v_file.presentation_class else null end,
      'presentation_fallback', case when v_proceed then v_file.presentation_fallback else null end,
      'presentation_fallback_reason', case
        when v_proceed then v_file.presentation_fallback_reason else null
      end,
      'model_composition_prose_accepted', false
    )),
    p_source
  );

  return query
  select
    v_file.id,
    v_file.status,
    v_file.attempts,
    v_file.next_attempt_at,
    v_proceed,
    v_file.presentation_class,
    v_file.presentation_fallback,
    v_file.presentation_fallback_reason;
end;
$$;

comment on function public.record_description_failure(uuid, uuid, text, text, text, text) is
  'Fenced description failure path. The initial attempt gets retries after 1m, 2m and 5m; failed attempt 4 is terminal and visible. A description cost-ceiling breach still uses the deliberate no-description fallback immediately.';

create or replace function public.record_image_redo_failure(
  p_job_id uuid,
  p_lease_token uuid,
  p_error text,
  p_error_code text,
  p_retryable boolean,
  p_source text default 'redo-worker'
)
returns table (
  status public.image_redo_status,
  attempts integer,
  next_attempt_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_job public.image_redo_jobs%rowtype;
  v_attempts integer;
  v_retry boolean;
  v_next timestamptz;
  v_status public.image_redo_status;
begin
  select *
    into v_job
    from public.image_redo_jobs j
   where j.id = p_job_id
     and j.status = 'processing'
     and j.lease_token = p_lease_token
     and j.lease_expires_at > now()
   for update;

  if not found then
    raise exception 'record_image_redo_failure: lease is no longer current'
      using errcode = '55000';
  end if;

  v_attempts := least(4, v_job.attempts + 1);
  -- Once a paid request was dispatched, an absent result is ambiguous. Never
  -- automatically dispatch a second paid request for the same job.
  v_retry := p_retryable and v_job.generation_started_at is null and v_attempts < 4;
  v_status := case
    when v_retry then 'queued'::public.image_redo_status
    else 'failed'::public.image_redo_status
  end;
  v_next := case
    when not v_retry then now()
    when v_attempts = 1 then now() + interval '1 minute'
    when v_attempts = 2 then now() + interval '2 minutes'
    when v_attempts = 3 then now() + interval '5 minutes'
  end;

  update public.image_redo_jobs
     set status = v_status,
         attempts = v_attempts,
         next_attempt_at = v_next,
         lease_token = null,
         lease_expires_at = null,
         last_error = coalesce(nullif(btrim(p_error), ''), 'Image redo failed.'),
         last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'image_redo_failed')
   where id = p_job_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_redo',
    p_job_id,
    case when v_retry then 'image.redo_retry_scheduled' else 'image.redo_failed' end,
    jsonb_build_object(
      'intake_file_id', v_job.intake_file_id,
      'version_no', v_job.version_no,
      'attempts', v_attempts,
      'retryable', v_retry,
      'retry_budget_exhausted', p_retryable and v_attempts >= 4,
      'generation_started', v_job.generation_started_at is not null,
      'error', coalesce(nullif(btrim(p_error), ''), 'Image redo failed.'),
      'code', coalesce(nullif(btrim(p_error_code), ''), 'image_redo_failed')
    ),
    p_source
  );

  return query select v_status, v_attempts, v_next;
end;
$$;

comment on function public.record_image_redo_failure(uuid, uuid, text, text, boolean, text) is
  'Fenced manual-redo failure path. The initial attempt gets retries after 1m, 2m and 5m; failed attempt 4 is terminal. A possibly-dispatched paid request still fails immediately rather than risking duplicate spend.';

-- Shorten queued intake work to the new deadlines. updated_at is the durable
-- timestamp of the failure that scheduled the old delay.
with candidates as materialized (
  select
    f.id,
    f.next_attempt_at as previous_next_attempt_at,
    f.updated_at + case f.attempts
      when 2 then interval '2 minutes'
      when 3 then interval '5 minutes'
    end as revised_next_attempt_at
  from public.intake_files f
  where f.status = 'discovered'
    and f.attempts in (2, 3)
  for update
), shortened as (
  update public.intake_files f
     set next_attempt_at = c.revised_next_attempt_at
    from candidates c
   where f.id = c.id
     and f.next_attempt_at > c.revised_next_attempt_at
  returning f.id, c.previous_next_attempt_at, c.revised_next_attempt_at
)
insert into public.events (entity_type, entity_id, event, detail, actor)
select
  'intake_file',
  s.id,
  'retry.policy_rescheduled',
  jsonb_build_object(
    'previous_next_attempt_at', s.previous_next_attempt_at,
    'next_attempt_at', s.revised_next_attempt_at,
    'policy', '1m/2m/5m'
  ),
  'migration:three-short-enhancement-retries'
from shortened s;

-- Anything already waiting after four completed failures has exhausted the new
-- budget and should show its existing error instead of receiving an old 1-hour
-- retry.
with exhausted as materialized (
  select f.id
  from public.intake_files f
  where f.status = 'discovered'
    and f.attempts >= 4
  for update
), failed as (
  update public.intake_files f
     set status = 'failed',
         next_attempt_at = now(),
         lease_token = null,
         lease_expires_at = null,
         last_error = coalesce(f.last_error, 'Enhancement failed after three retries.'),
         last_error_code = coalesce(f.last_error_code, 'retry_budget_exhausted'),
         error_class = coalesce(f.error_class, 'retryable'::public.error_class)
    from exhausted e
   where f.id = e.id
  returning f.id, f.attempts, f.last_error, f.last_error_code
)
insert into public.events (entity_type, entity_id, event, detail, actor)
select
  'intake_file',
  f.id,
  'intake.failed',
  jsonb_build_object(
    'error', f.last_error,
    'code', f.last_error_code,
    'attempts', f.attempts,
    'retry_budget_exhausted', true,
    'policy', '1m/2m/5m'
  ),
  'migration:three-short-enhancement-retries'
from failed f;

with candidates as materialized (
  select
    j.id,
    j.next_attempt_at as previous_next_attempt_at,
    j.updated_at + case j.attempts
      when 2 then interval '2 minutes'
      when 3 then interval '5 minutes'
    end as revised_next_attempt_at
  from public.image_redo_jobs j
  where j.status = 'queued'
    and j.attempts in (2, 3)
  for update
), shortened as (
  update public.image_redo_jobs j
     set next_attempt_at = c.revised_next_attempt_at
    from candidates c
   where j.id = c.id
     and j.next_attempt_at > c.revised_next_attempt_at
  returning j.id, c.previous_next_attempt_at, c.revised_next_attempt_at
)
insert into public.events (entity_type, entity_id, event, detail, actor)
select
  'image_redo',
  s.id,
  'retry.policy_rescheduled',
  jsonb_build_object(
    'previous_next_attempt_at', s.previous_next_attempt_at,
    'next_attempt_at', s.revised_next_attempt_at,
    'policy', '1m/2m/5m'
  ),
  'migration:three-short-enhancement-retries'
from shortened s;

with exhausted as materialized (
  select j.id
  from public.image_redo_jobs j
  where j.status = 'queued'
    and j.attempts >= 4
  for update
), failed as (
  update public.image_redo_jobs j
     set status = 'failed',
         next_attempt_at = now(),
         lease_token = null,
         lease_expires_at = null,
         last_error = coalesce(j.last_error, 'Image redo failed after three retries.'),
         last_error_code = coalesce(j.last_error_code, 'retry_budget_exhausted')
    from exhausted e
   where j.id = e.id
  returning j.id, j.intake_file_id, j.attempts, j.last_error, j.last_error_code
)
insert into public.events (entity_type, entity_id, event, detail, actor)
select
  'image_redo',
  f.id,
  'image.redo_failed',
  jsonb_build_object(
    'intake_file_id', f.intake_file_id,
    'error', f.last_error,
    'code', f.last_error_code,
    'attempts', f.attempts,
    'retry_budget_exhausted', true,
    'policy', '1m/2m/5m'
  ),
  'migration:three-short-enhancement-retries'
from failed f;
