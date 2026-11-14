-- D170: every photograph of an Enhance job carries its own state, an undelivered photograph goes back
-- to the queue by itself (three tries, then a human looks), a job can wait for a limit or a sign-in,
-- and the runner reports its limits and takes a few fixed commands from the page.
--
-- Additive. The runner of before keeps working: it claims with two arguments and finishes with
-- done / failed, and both still answer.

alter table public.agent_job_photos
  add column work_state text not null default 'waiting'
             check (work_state in ('waiting', 'working', 'done', 'restock', 'failed')),
  add column attempts   integer not null default 0,
  add column last_error text,
  add column worked_at  timestamptz,
  add column thumb_key  text;
create index agent_job_photos_work_idx on public.agent_job_photos (job_id, work_state);
create index intake_files_agent_source_photo_idx on public.intake_files (agent_source_photo_id)
  where agent_source_photo_id is not null;

comment on column public.agent_job_photos.work_state is
  'D170: waiting (in the queue), working (claimed by the running pass), done (a delivery names it), restock (waits in or left the Restock section), failed (three tries, a human looks).';

alter table public.agent_jobs
  add column not_before  timestamptz,
  add column hold_reason text check (hold_reason in ('limit', 'login')),
  add column passes      integer not null default 0;

comment on column public.agent_jobs.not_before is
  'D170: a queued job is not claimed before this moment (a limit resets then, or a retry backs off).';

-- What already happened, told honestly: a photograph with a delivery is done, a restock is a restock,
-- and a photograph of a finished job with neither was never delivered.
update public.agent_job_photos p
   set work_state = case
         when p.restock_state is not null then 'restock'
         when exists (select 1 from public.intake_files f where f.agent_source_photo_id = p.id) then 'done'
         when j.kind = 'redo' and j.status = 'done' then 'done'
         when j.status in ('done', 'failed') then 'failed'
         else 'waiting' end,
       last_error = case
         when p.restock_state is null and j.status in ('done', 'failed') and not (j.kind = 'redo' and j.status = 'done')
              and not exists (select 1 from public.intake_files f where f.agent_source_photo_id = p.id)
         then 'No delivery on record (from before per-photo tracking).' end
  from public.agent_jobs j
 where j.id = p.job_id;

-- The database says what is true: a photograph is done when a delivery names it.
create or replace function public.agent_job_sync_photos(p_job_id uuid)
returns void
language sql volatile security invoker set search_path = public, pg_temp
as $$
  update public.agent_job_photos p
     set work_state = case when p.restock_state is not null then 'restock' else 'done' end,
         worked_at = coalesce(p.worked_at, now()), last_error = null
   where p.job_id = p_job_id and p.work_state in ('waiting', 'working', 'failed')
     and (p.restock_state is not null
          or exists (select 1 from public.intake_files f where f.agent_source_photo_id = p.id)
          -- A redo delivers by replacing: the replacement clears the image's reenhance_job_id.
          or exists (select 1 from public.agent_jobs j
                      where j.id = p.job_id and j.kind = 'redo' and j.redo_of_intake_id is not null
                        and not exists (select 1 from public.intake_files f
                                         where f.id = j.redo_of_intake_id and f.reenhance_job_id = j.id)));
$$;

-- One pass over a job has ended. Photographs still 'working' were not delivered: after a limit or a
-- lost sign-in they simply wait again; otherwise it was a try, and the third failed try is final.
-- The job goes back to the queue while anything waits, and is finished when nothing does.
create or replace function public.agent_job_close_pass(
  p_job_id uuid, p_outcome text, p_resume_at timestamptz, p_note text, p_error text, p_result_count integer, p_actor text
)
returns text
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job     public.agent_jobs%rowtype;
  v_err     text := nullif(left(btrim(coalesce(p_error, '')), 2000), '');
  v_note    text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_waiting integer;
  v_done    integer;
  v_failed  integer;
  v_retried integer := 0;
  v_status  text;
begin
  if p_outcome not in ('ok', 'limit', 'login', 'error') then
    raise exception 'agent_job_close_pass: outcome must be ok, limit, login or error' using errcode = '22023';
  end if;
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_close_pass: no job %', p_job_id using errcode = 'P0002';
  end if;
  perform public.agent_job_sync_photos(p_job_id);
  if p_outcome in ('limit', 'login') then
    update public.agent_job_photos set work_state = 'waiting' where job_id = p_job_id and work_state = 'working';
  else
    update public.agent_job_photos
       set attempts = attempts + 1,
           work_state = case when attempts + 1 >= 3 then 'failed' else 'waiting' end,
           last_error = left(coalesce(v_err, 'The run ended without delivering this photograph.'), 500),
           worked_at = now()
     where job_id = p_job_id and work_state = 'working';
    get diagnostics v_retried = row_count;
  end if;
  select count(*) filter (where work_state = 'waiting'), count(*) filter (where work_state in ('done', 'restock')),
         count(*) filter (where work_state = 'failed')
    into v_waiting, v_done, v_failed
    from public.agent_job_photos where job_id = p_job_id and status = 'uploaded';

  if v_waiting > 0 then
    v_status := 'queued';
    update public.agent_jobs
       set status = 'queued', lease_until = null, finished_at = null,
           not_before = case when p_outcome = 'limit' then p_resume_at
                             -- A photograph that was tried and not delivered backs off a minute; a batch that
                             -- simply has more photographs than one pass takes goes on at once.
                             when p_outcome <> 'login' and v_retried > 0 then now() + interval '1 minute' end,
           hold_reason = case when p_outcome in ('limit', 'login') then p_outcome end,
           note = coalesce(v_note, note),
           error = case when p_outcome = 'ok' then null else v_err end,
           result_count = result_count + greatest(coalesce(p_result_count, 0), 0)
     where id = p_job_id;
  else
    v_status := case when v_done > 0 then 'done' else 'failed' end;
    update public.agent_jobs
       set status = v_status, lease_until = null, finished_at = now(), not_before = null, hold_reason = null,
           note = coalesce(v_note, note),
           error = case when v_failed > 0 then coalesce(v_err, error) else null end,
           result_count = result_count + greatest(coalesce(p_result_count, 0), 0)
     where id = p_job_id;
    if v_job.kind = 'redo' and v_job.redo_of_intake_id is not null then
      update public.intake_files set reenhance_job_id = null, reenhance_note = null
       where id = v_job.redo_of_intake_id and reenhance_job_id = p_job_id;
    end if;
  end if;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', p_job_id, case when v_status = 'queued' then 'agent_job.requeued' else 'agent_job.' || v_status end,
          jsonb_strip_nulls(jsonb_build_object('label', v_job.label, 'kind', v_job.kind, 'outcome', p_outcome,
                                               'waiting', v_waiting, 'done', v_done, 'failed', v_failed,
                                               'result_count', coalesce(p_result_count, 0), 'resume_at', p_resume_at, 'note', v_note)),
          btrim(p_actor));
  return v_status;
end;
$$;

-- Claim: a queued job whose wait is over, or a running one whose runner went silent. The lapsed run
-- counts as a failed try for its photographs, so a crash that repeats stops after three. The claim
-- takes at most p_max_photos waiting photographs; the rest stay in the queue for the next pass.
drop function public.agent_job_claim(text, integer);
create function public.agent_job_claim(p_runner text, p_lease_seconds integer, p_max_photos integer default null)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job   public.agent_jobs%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 1800), 60), 14400);
  v_max   integer := least(greatest(coalesce(p_max_photos, 1000), 1), 1000);
  v_taken integer;
  v_retaken boolean;
begin
  select * into v_job from public.agent_jobs
   where (status = 'queued' and (not_before is null or not_before <= now()))
      or (status = 'running' and lease_until < now())
   order by queued_at nulls last
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;
  v_retaken := v_job.status = 'running';
  if v_retaken then
    -- A run whose lease lapsed counts as a failed try. Its photographs wait their minute like any other
    -- failed try, so a run that crashes at once cannot spin; the next claim takes them.
    perform public.agent_job_close_pass(v_job.id, 'error', null, null, 'The runner stopped in the middle of the run.', 0, p_runner);
    return null;
  else
    perform public.agent_job_sync_photos(v_job.id);
  end if;
  update public.agent_job_photos set work_state = 'working'
   where id in (select id from public.agent_job_photos
                 where job_id = v_job.id and status = 'uploaded' and work_state = 'waiting'
                 order by created_at, id limit v_max);
  get diagnostics v_taken = row_count;
  if v_taken = 0 then
    perform public.agent_job_close_pass(v_job.id, 'ok', null, null, null, 0, p_runner);
    return null;
  end if;
  update public.agent_jobs
     set status = 'running', runner = btrim(p_runner), lease_until = now() + make_interval(secs => v_lease),
         started_at = coalesce(started_at, now()), finished_at = null, error = null,
         not_before = null, hold_reason = null, passes = passes + 1
   where id = v_job.id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', v_job.id, 'agent_job.claimed',
          jsonb_build_object('label', v_job.label, 'kind', v_job.kind, 'lease_seconds', v_lease, 'retaken', v_retaken,
                             'photos', v_taken, 'pass', v_job.passes + 1), btrim(p_runner));
  return jsonb_build_object('id', v_job.id, 'label', v_job.label, 'photo_count', v_taken,
                            'kind', v_job.kind, 'instructions', v_job.instructions, 'redo_of', v_job.redo_of_intake_id,
                            'pass', v_job.passes + 1);
end;
$$;

-- The runner's report after a pass. outcome: ok (ran to the end), limit (Claude or Codex ran out;
-- p_resume_at says when it resets), login (Claude or Codex is signed out), error (anything else).
create or replace function public.agent_job_pass(
  p_job_id uuid, p_runner text, p_outcome text, p_resume_at timestamptz, p_note text, p_error text, p_result_count integer
)
returns text
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
begin
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_pass: no job %', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' or v_job.runner is distinct from btrim(p_runner) then
    raise exception 'agent_job_pass: job % is not running under %', p_job_id, p_runner using errcode = '55000';
  end if;
  return public.agent_job_close_pass(p_job_id, p_outcome, p_resume_at, p_note, p_error, p_result_count, p_runner);
end;
$$;

-- The runner of before says done or failed; both are a pass that ended.
create or replace function public.agent_job_finish(
  p_job_id uuid, p_runner text, p_status text, p_note text, p_error text, p_result_count integer
)
returns void
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
begin
  if p_status not in ('done', 'failed') then
    raise exception 'agent_job_finish: status must be done or failed' using errcode = '22023';
  end if;
  perform public.agent_job_pass(p_job_id, p_runner, case when p_status = 'done' then 'ok' else 'error' end, null, p_note, p_error, p_result_count);
end;
$$;

-- An operator sends failed photographs back: all of a job's (p_photo_ids null) or the ones named.
create or replace function public.agent_job_retry_photos(p_job_id uuid, p_photo_ids uuid[], p_actor text)
returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_n   integer;
begin
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_retry_photos: no job %', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status = 'collecting' then
    raise exception 'agent_job_retry_photos: the batch was never sent' using errcode = '55000';
  end if;
  update public.agent_job_photos
     set work_state = 'waiting', attempts = 0, last_error = null
   where job_id = p_job_id and status = 'uploaded' and work_state = 'failed'
     and (p_photo_ids is null or id = any (p_photo_ids));
  get diagnostics v_n = row_count;
  if v_n > 0 and v_job.kind = 'redo' and v_job.redo_of_intake_id is not null then
    update public.intake_files set reenhance_job_id = p_job_id
     where id = v_job.redo_of_intake_id and reenhance_job_id is null;
  end if;
  if v_n > 0 and v_job.status in ('done', 'failed') then
    update public.agent_jobs
       set status = 'queued', queued_at = now(), finished_at = null, not_before = null, hold_reason = null, error = null
     where id = p_job_id;
  end if;
  if v_n > 0 then
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('agent_job', p_job_id, 'agent_job.photos_retried', jsonb_build_object('label', v_job.label, 'photos', v_n), btrim(p_actor));
  end if;
  return v_n;
end;
$$;

-- "Try now": every job waiting for a limit may be claimed at once.
create or replace function public.agent_jobs_release_holds(p_actor text)
returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  update public.agent_jobs set not_before = null, hold_reason = null
   where status = 'queued' and (not_before is not null or hold_reason is not null);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The runner's own report: limits, sign-in state, what it is doing, the tail of its log. One row per runner.
create table public.agent_runner_status (
  runner   text primary key check (length(btrim(runner)) between 1 and 60),
  status   jsonb not null default '{}'::jsonb,
  log      text not null default '',
  seen_at  timestamptz not null default now()
);
alter table public.agent_runner_status enable row level security;

-- The few things the page may ask of the runner. Fixed kinds; the runner runs no free text.
create table public.agent_runner_commands (
  id         uuid primary key default gen_random_uuid(),
  runner     text not null,
  kind       text not null check (kind in ('pause', 'resume', 'try_now', 'claude_login_start', 'claude_login_code',
                                           'codex_login_start', 'login_cancel')),
  payload    jsonb not null default '{}'::jsonb,
  state      text not null default 'pending' check (state in ('pending', 'sent', 'done', 'failed')),
  result     text,
  created_by text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  done_at    timestamptz
);
create index agent_runner_commands_pending_idx on public.agent_runner_commands (runner, created_at) where state = 'pending';
alter table public.agent_runner_commands enable row level security;

-- The runner's heartbeat: store the report, close the commands it answered, hand out the pending ones.
create or replace function public.agent_runner_report(p_runner text, p_status jsonb, p_log text, p_results jsonb)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_runner text := btrim(p_runner);
  v_out    jsonb;
begin
  insert into public.agent_runner_status (runner, status, log, seen_at)
  values (v_runner, coalesce(p_status, '{}'::jsonb), left(coalesce(p_log, ''), 20000), now())
  on conflict (runner) do update set status = excluded.status, log = excluded.log, seen_at = excluded.seen_at;
  update public.agent_runner_commands c
     set state = case when (r->>'ok')::boolean then 'done' else 'failed' end,
         result = left(r->>'result', 500), done_at = now(), payload = '{}'::jsonb
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
   where c.id = (r->>'id')::uuid and c.runner = v_runner and c.state = 'sent';
  -- A command nobody fetched within ten minutes is stale (a sign-in code is long dead by then).
  update public.agent_runner_commands set state = 'failed', result = 'The server did not pick this up in time.', done_at = now(), payload = '{}'::jsonb
   where runner = v_runner and state = 'pending' and created_at < now() - interval '10 minutes';
  with picked as (
    update public.agent_runner_commands set state = 'sent', sent_at = now()
     where id in (select id from public.agent_runner_commands where runner = v_runner and state = 'pending' order by created_at limit 5)
    returning id, kind, payload, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'payload', payload) order by created_at), '[]'::jsonb) into v_out from picked;
  return v_out;
end;
$$;

revoke all on table public.agent_runner_status from anon, authenticated;
revoke all on table public.agent_runner_commands from anon, authenticated;
revoke all on function public.agent_job_sync_photos(uuid) from public, anon, authenticated;
revoke all on function public.agent_job_close_pass(uuid, text, timestamptz, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.agent_job_claim(text, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_job_pass(uuid, text, text, timestamptz, text, text, integer) from public, anon, authenticated;
revoke all on function public.agent_job_retry_photos(uuid, uuid[], text) from public, anon, authenticated;
revoke all on function public.agent_jobs_release_holds(text) from public, anon, authenticated;
revoke all on function public.agent_runner_report(text, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.agent_job_sync_photos(uuid) to service_role;
grant execute on function public.agent_job_close_pass(uuid, text, timestamptz, text, text, integer, text) to service_role;
grant execute on function public.agent_job_claim(text, integer, integer) to service_role;
grant execute on function public.agent_job_pass(uuid, text, text, timestamptz, text, text, integer) to service_role;
grant execute on function public.agent_job_retry_photos(uuid, uuid[], text) to service_role;
grant execute on function public.agent_jobs_release_holds(text) to service_role;
grant execute on function public.agent_runner_report(text, jsonb, text, jsonb) to service_role;
