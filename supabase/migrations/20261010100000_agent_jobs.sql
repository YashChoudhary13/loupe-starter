-- D143: Enhance jobs. The operator photographs new stock on a phone and sends the photos here;
-- an external enhancer (Claude on the Canada server) claims the job, downloads the photos, renders
-- and pushes the finals through /api/agent/images with the job's label as the batch (D142), so
-- intake_files.agent_batch = agent_jobs.label links the two.

create table public.agent_jobs (
  id            uuid primary key default gen_random_uuid(),
  label         text not null unique check (length(btrim(label)) between 3 and 80),
  status        text not null default 'collecting'
                check (status in ('collecting', 'queued', 'running', 'done', 'failed')),
  created_by    text not null,
  created_at    timestamptz not null default now(),
  queued_at     timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  lease_until   timestamptz,
  runner        text,
  note          text,
  photo_count   integer not null default 0,
  result_count  integer not null default 0,
  error         text
);
create index agent_jobs_status_idx on public.agent_jobs (status, queued_at);

create table public.agent_job_photos (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.agent_jobs (id) on delete cascade,
  storage_key text not null unique,
  filename    text not null,
  bytes       integer,
  width       integer,
  height      integer,
  status      text not null default 'pending' check (status in ('pending', 'uploaded')),
  created_at  timestamptz not null default now()
);
create index agent_job_photos_job_idx on public.agent_job_photos (job_id);

comment on table public.agent_jobs is
  'D143: one batch of supplier photographs waiting for, or processed by, the external enhancer. label is the D142 batch label.';

-- The browser PUT landed (the server checked the object): mark the photo and recount the job.
create or replace function public.agent_job_photo_uploaded(p_photo_id uuid, p_bytes integer)
returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job uuid;
  v_count integer;
begin
  update public.agent_job_photos set status = 'uploaded', bytes = coalesce(p_bytes, bytes)
   where id = p_photo_id returning job_id into v_job;
  if v_job is null then
    raise exception 'agent_job_photo_uploaded: no photo %', p_photo_id using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.agent_job_photos where job_id = v_job and status = 'uploaded';
  update public.agent_jobs set photo_count = v_count where id = v_job and status = 'collecting';
  return v_count;
end;
$$;

-- "Send for enhancement": collecting -> queued, only with at least one uploaded photo.
create or replace function public.agent_job_queue(p_job_id uuid, p_actor text)
returns void
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
begin
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_queue: no job %', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status <> 'collecting' then
    raise exception 'agent_job_queue: the batch is already %', v_job.status using errcode = '55000';
  end if;
  if v_job.photo_count < 1 then
    raise exception 'agent_job_queue: the batch has no uploaded photographs' using errcode = '22023';
  end if;
  update public.agent_jobs set status = 'queued', queued_at = now(), error = null where id = p_job_id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', p_job_id, 'agent_job.queued',
          jsonb_build_object('label', v_job.label, 'photo_count', v_job.photo_count), btrim(p_actor));
end;
$$;

-- The enhancer takes the oldest queued job, or a running one whose lease ran out (the runner died).
-- One row, locked, skip-locked: two runners never take the same job.
create or replace function public.agent_job_claim(p_runner text, p_lease_seconds integer)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 1800), 60), 14400);
begin
  select * into v_job from public.agent_jobs
   where status = 'queued' or (status = 'running' and lease_until < now())
   order by queued_at nulls last
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;
  update public.agent_jobs
     set status = 'running', runner = btrim(p_runner), lease_until = now() + make_interval(secs => v_lease),
         started_at = coalesce(started_at, now()), error = null
   where id = v_job.id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', v_job.id, 'agent_job.claimed',
          jsonb_build_object('label', v_job.label, 'lease_seconds', v_lease, 'retaken', v_job.status = 'running'), btrim(p_runner));
  return jsonb_build_object('id', v_job.id, 'label', v_job.label, 'photo_count', v_job.photo_count);
end;
$$;

create or replace function public.agent_job_heartbeat(p_job_id uuid, p_runner text, p_lease_seconds integer)
returns void
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 1800), 60), 14400);
begin
  update public.agent_jobs set lease_until = now() + make_interval(secs => v_lease)
   where id = p_job_id and status = 'running' and runner = btrim(p_runner);
  if not found then
    raise exception 'agent_job_heartbeat: job % is not running under %', p_job_id, p_runner using errcode = '55000';
  end if;
end;
$$;

create or replace function public.agent_job_finish(
  p_job_id uuid, p_runner text, p_status text, p_note text, p_error text, p_result_count integer
)
returns void
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'agent_job_finish: status must be done or failed' using errcode = '22023';
  end if;
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_finish: no job %', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' or v_job.runner is distinct from btrim(p_runner) then
    raise exception 'agent_job_finish: job % is not running under %', p_job_id, p_runner using errcode = '55000';
  end if;
  update public.agent_jobs
     set status = p_status, finished_at = now(), lease_until = null,
         note = nullif(left(btrim(coalesce(p_note, '')), 500), ''),
         error = case when p_status = 'failed' then nullif(left(btrim(coalesce(p_error, '')), 2000), '') else null end,
         result_count = greatest(coalesce(p_result_count, 0), 0)
   where id = p_job_id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', p_job_id, 'agent_job.' || p_status,
          jsonb_strip_nulls(jsonb_build_object('label', v_job.label, 'result_count', coalesce(p_result_count, 0),
                                               'note', nullif(btrim(coalesce(p_note, '')), ''))), btrim(p_runner));
end;
$$;

revoke all on function public.agent_job_photo_uploaded(uuid, integer) from public, anon, authenticated;
revoke all on function public.agent_job_queue(uuid, text) from public, anon, authenticated;
revoke all on function public.agent_job_claim(text, integer) from public, anon, authenticated;
revoke all on function public.agent_job_heartbeat(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.agent_job_finish(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.agent_job_photo_uploaded(uuid, integer) to service_role;
grant execute on function public.agent_job_queue(uuid, text) to service_role;
grant execute on function public.agent_job_claim(text, integer) to service_role;
grant execute on function public.agent_job_heartbeat(uuid, text, integer) to service_role;
grant execute on function public.agent_job_finish(uuid, text, text, text, text, integer) to service_role;
