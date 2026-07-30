-- The table-returning function has an output column named `id`. Qualify the
-- image_versions lookup so PL/pgSQL never confuses that output variable with
-- the table column.

create or replace function public.claim_image_redo(
  p_lease_seconds integer default 300,
  p_job_id uuid default null
)
returns table (
  id uuid,
  intake_file_id uuid,
  source_version_id uuid,
  source_storage_key text,
  version_no integer,
  prompt_id uuid,
  prompt_text text,
  model text,
  description_injected boolean,
  description_missing boolean,
  attempts integer,
  lease_token uuid,
  lease_expires_at timestamptz,
  generation_started_at timestamptz
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.image_redo_jobs%rowtype;
  v_source_key text;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 900 then
    raise exception 'claim_image_redo: lease must be 1..900 seconds'
      using errcode = '22023';
  end if;

  with candidate as (
    select j.id
      from public.image_redo_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and j.next_attempt_at <= now()
       and (
         j.status = 'queued'
         or (
           j.status = 'processing'
           and j.lease_expires_at <= now()
         )
       )
     order by j.next_attempt_at, j.created_at, j.id
     limit 1
       for update skip locked
  )
  update public.image_redo_jobs j
     set status = 'processing',
         lease_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from candidate c
   where j.id = c.id
  returning j.* into v_job;

  if not found then
    return;
  end if;

  select iv.storage_key
    into v_source_key
    from public.image_versions iv
   where iv.id = v_job.source_version_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_redo',
    v_job.id,
    case
      when v_job.generation_started_at is null then 'image.redo_claimed'
      else 'image.redo_recovered'
    end,
    jsonb_build_object(
      'intake_file_id', v_job.intake_file_id,
      'version_no', v_job.version_no,
      'lease_token', v_job.lease_token,
      'lease_expires_at', v_job.lease_expires_at,
      'generation_already_started', v_job.generation_started_at is not null
    ),
    'redo-worker'
  );

  return query
  select
    v_job.id,
    v_job.intake_file_id,
    v_job.source_version_id,
    v_source_key,
    v_job.version_no,
    v_job.prompt_id,
    v_job.prompt_text,
    v_job.model,
    v_job.description_injected,
    v_job.description_missing,
    v_job.attempts,
    v_job.lease_token,
    v_job.lease_expires_at,
    v_job.generation_started_at;
end;
$$;
