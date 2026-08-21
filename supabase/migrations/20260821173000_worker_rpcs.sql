-- D111: the vision worker's only door into the database.
--
-- The Windows laptop (and the optional CPU fallback on a VPS) never holds a
-- database or R2 credential. It talks to /api/worker/*, which authenticates a
-- shared secret and then calls exactly these functions. Every mutation after a
-- claim is fenced by the UUID lease token (hard rule 6), so a worker that wakes
-- after its lease expired cannot overwrite the worker that replaced it.

create or replace function public.worker_heartbeat(
  p_worker  text,
  p_device  text,
  p_kinds   text[],
  p_version text
)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  insert into public.match_workers (worker_id, device, kinds, version, last_seen_at)
  values (p_worker, p_device, p_kinds, p_version, now())
  on conflict (worker_id) do update
     set device = excluded.device, kinds = excluded.kinds, version = excluded.version, last_seen_at = now();
$$;

-- Claims the oldest queued job of the requested kinds, or one whose lease has
-- expired (the sweeper is inline: a crashed worker's job is simply claimable
-- again). Returns the job with the columns the route needs to build the worker's
-- payload; the route turns storage keys into presigned URLs.
create or replace function public.claim_match_job(
  p_worker        text,
  p_kinds         text[],
  p_lease_seconds integer default 600
)
returns table (
  job_id           uuid,
  kind             text,
  lease_token      uuid,
  lease_expires_at timestamptz,
  attempts         integer,
  reference_id     uuid,
  ref_sku          text,
  ref_handle       text,
  ref_storage_key  text,
  ref_image_url    text,
  ref_local_path   text,
  ref_sha256       text,
  match_event_id   uuid,
  event_query_key  text,
  event_surface    text
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job   public.match_jobs%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'claim_match_job: p_worker is required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_match_job: p_lease_seconds must be positive' using errcode = '22023';
  end if;

  with candidate as (
    select j.id
      from public.match_jobs as j
     where j.kind = any (p_kinds)
       and (j.status = 'queued'
            or (j.status = 'claimed' and j.lease_expires_at < now()))
     order by case when j.kind = 'identify' then 0 else 1 end, j.created_at, j.id
     limit 1
       for update skip locked
  )
  update public.match_jobs as j
     set status           = 'claimed',
         worker_id        = p_worker,
         lease_token      = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts         = j.attempts + 1,
         claimed_at       = now()
    from candidate as c
   where j.id = c.id
  returning j.* into v_job;

  if not found then
    return;
  end if;

  if v_job.reference_id is not null then
    update public.match_references
       set status = case when v_job.kind = 'embed' and status in ('synced', 'queued', 'failed') then 'queued' else status end
     where id = v_job.reference_id;
  end if;

  return query
  select v_job.id, v_job.kind, v_job.lease_token, v_job.lease_expires_at, v_job.attempts,
         r.id, r.sku, r.handle, r.storage_key, r.image_url, r.local_path, r.sha256,
         e.id, e.query_storage_key, e.surface
    from (select 1) as one
    left join public.match_references as r on r.id = v_job.reference_id
    left join public.match_events     as e on e.id = v_job.match_event_id;
end;
$$;

-- The bytes behind a Drive photograph, for /api/worker/source. Only the worker
-- holding the live lease may ask.
create or replace function public.match_job_source(
  p_job   uuid,
  p_token uuid
)
returns table (drive_file_id text, mime_type text, filename text)
language sql
stable
set search_path = public, pg_temp
as $$
  select f.drive_file_id, f.mime_type, f.filename
    from public.match_jobs   as j
    join public.match_events as e on e.id = j.match_event_id
    join public.intake_files as f on f.id = e.intake_file_id
   where j.id = p_job
     and j.status = 'claimed'
     and j.lease_token = p_token
     and j.lease_expires_at >= now()
     and e.query_storage_key like 'drive:%';
$$;

create or replace function public.complete_match_job(
  p_job    uuid,
  p_token  uuid,
  p_result jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job public.match_jobs%rowtype;
begin
  select * into v_job from public.match_jobs where id = p_job for update;
  if not found or v_job.status <> 'claimed' or v_job.lease_token is distinct from p_token then
    raise exception 'complete_match_job: lease lost for job %', p_job
      using errcode = '55000',
            hint = 'The job was reclaimed by another worker or already finished. Nothing was recorded.';
  end if;

  if v_job.kind = 'sync' then
    update public.match_references
       set status     = 'synced',
           synced_at  = now(),
           local_path = coalesce(p_result ->> 'local_path', local_path),
           sha256     = coalesce(p_result ->> 'sha256', sha256),
           last_error = null
     where id = v_job.reference_id;
    -- The embedding is the next step; when it runs is the worker's schedule
    -- (nightly on the laptop), not the queue's concern.
    insert into public.match_jobs (kind, reference_id)
    select 'embed', v_job.reference_id
     where not exists (
       select 1 from public.match_jobs
        where reference_id = v_job.reference_id and kind = 'embed' and status in ('queued', 'claimed'));
  elsif v_job.kind = 'embed' then
    if (select count(*) from public.match_embeddings where reference_id = v_job.reference_id) < 2 then
      raise exception 'complete_match_job: both views must be stored before an embed job completes'
        using errcode = '22023';
    end if;
    update public.match_references
       set status        = 'indexed',
           embedded_at   = now(),
           indexed_at    = now(),
           index_version = coalesce(p_result ->> 'index_version', to_char(now(), 'YYYY-MM-DD')),
           last_error    = null
     where id = v_job.reference_id;
  end if;

  update public.match_jobs
     set status = 'done', finished_at = now(), lease_token = null, lease_expires_at = null
   where id = p_job;
end;
$$;

create or replace function public.fail_match_job(
  p_job       uuid,
  p_token     uuid,
  p_error     text,
  p_retryable boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job     public.match_jobs%rowtype;
  v_final   boolean;
begin
  select * into v_job from public.match_jobs where id = p_job for update;
  if not found or v_job.status <> 'claimed' or v_job.lease_token is distinct from p_token then
    raise exception 'fail_match_job: lease lost for job %', p_job using errcode = '55000';
  end if;

  -- Bounded retries, then a human looks (hard rule 4).
  v_final := not coalesce(p_retryable, false) or v_job.attempts >= 4;

  update public.match_jobs
     set status           = case when v_final then 'failed' else 'queued' end,
         last_error       = left(p_error, 2000),
         lease_token      = null,
         lease_expires_at = null,
         finished_at      = case when v_final then now() else null end
   where id = p_job;

  if v_job.reference_id is not null then
    update public.match_references
       set last_error = left(p_error, 2000),
           status     = case when v_final then 'failed' else status end
     where id = v_job.reference_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'match_job', p_job, case when v_final then 'match.job_failed' else 'match.job_retry_scheduled' end,
    jsonb_build_object('kind', v_job.kind, 'attempts', v_job.attempts, 'error', left(p_error, 500),
                       'reference_id', v_job.reference_id, 'match_event_id', v_job.match_event_id),
    v_job.worker_id
  );
end;
$$;

-- p_embedding is the pgvector text form '[0.1,0.2,...]' (1152 values). Declared
-- text so PostgREST passes it through untouched; the cast validates the length.
create or replace function public.store_match_embedding(
  p_reference uuid,
  p_view      text,
  p_embedding text,
  p_model     text
)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  insert into public.match_embeddings (reference_id, view, embedding, model)
  values (p_reference, p_view, p_embedding::extensions.vector(1152), p_model)
  on conflict (reference_id, view) do update
     set embedding = excluded.embedding, model = excluded.model, created_at = now();
$$;

-- Exact cosine search, max over every indexed reference view per SKU.
create or replace function public.match_search(
  p_embedding text,
  p_limit     integer default 10
)
returns table (sku text, handle text, score real)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.sku,
         (array_agg(r.handle order by (e.embedding operator(extensions.<=>) p_embedding::extensions.vector(1152))))[1] as handle,
         max(1 - (e.embedding operator(extensions.<=>) p_embedding::extensions.vector(1152)))::real as score
    from public.match_embeddings as e
    join public.match_references as r on r.id = e.reference_id
   where r.retired_at is null
     and r.status = 'indexed'
   group by r.sku
   order by score desc
   limit p_limit;
$$;

create or replace function public.record_match_candidates(
  p_event         uuid,
  p_candidates    jsonb,
  p_model         text,
  p_index_version text,
  p_crop_box      integer[],
  p_latency_ms    integer
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event public.match_events%rowtype;
begin
  select * into v_event from public.match_events where id = p_event for update;
  if not found then
    raise exception 'record_match_candidates: no match_event %', p_event using errcode = '22023';
  end if;
  if v_event.status = 'decided' then
    -- A late result for a photograph already decided is recorded for the audit
    -- trail but changes nothing about the decision.
    update public.match_events
       set candidates = coalesce(candidates, p_candidates), model = coalesce(model, p_model),
           index_version = coalesce(index_version, p_index_version)
     where id = p_event;
    return;
  end if;

  update public.match_events
     set status        = 'matched',
         candidates    = p_candidates,
         model         = p_model,
         index_version = p_index_version,
         crop_box      = p_crop_box,
         latency_ms    = p_latency_ms,
         matched_at    = now()
   where id = p_event;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    coalesce(case when v_event.intake_file_id is not null then 'intake_file' end, 'match_event'),
    coalesce(v_event.intake_file_id, p_event),
    'match.matched',
    jsonb_build_object('match_event_id', p_event, 'candidates', jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)),
                       'top_sku', p_candidates -> 0 ->> 'sku', 'latency_ms', p_latency_ms),
    'worker'
  );
end;
$$;

revoke execute on function public.worker_heartbeat(text, text, text[], text) from public, anon, authenticated;
grant  execute on function public.worker_heartbeat(text, text, text[], text) to service_role;
revoke execute on function public.claim_match_job(text, text[], integer) from public, anon, authenticated;
grant  execute on function public.claim_match_job(text, text[], integer) to service_role;
revoke execute on function public.match_job_source(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.match_job_source(uuid, uuid) to service_role;
revoke execute on function public.complete_match_job(uuid, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.complete_match_job(uuid, uuid, jsonb) to service_role;
revoke execute on function public.fail_match_job(uuid, uuid, text, boolean) from public, anon, authenticated;
grant  execute on function public.fail_match_job(uuid, uuid, text, boolean) to service_role;
revoke execute on function public.store_match_embedding(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.store_match_embedding(uuid, text, text, text) to service_role;
revoke execute on function public.match_search(text, integer) from public, anon, authenticated;
grant  execute on function public.match_search(text, integer) to service_role;
revoke execute on function public.record_match_candidates(uuid, jsonb, text, text, integer[], integer) from public, anon, authenticated;
grant  execute on function public.record_match_candidates(uuid, jsonb, text, text, integer[], integer) to service_role;

-- Fenced lookups for the route: which reference / event a claimed job is about.
-- Null when the lease is not live, so nothing is stored against a stale claim.
create or replace function public.match_job_reference(p_job uuid, p_token uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select j.reference_id from public.match_jobs as j
   where j.id = p_job and j.status = 'claimed' and j.lease_token = p_token and j.lease_expires_at >= now();
$$;

create or replace function public.match_job_event(p_job uuid, p_token uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select j.match_event_id from public.match_jobs as j
   where j.id = p_job and j.status = 'claimed' and j.lease_token = p_token and j.lease_expires_at >= now();
$$;

revoke execute on function public.match_job_reference(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.match_job_reference(uuid, uuid) to service_role;
revoke execute on function public.match_job_event(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.match_job_event(uuid, uuid) to service_role;
