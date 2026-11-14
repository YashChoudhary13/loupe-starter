-- D170: the owner can cancel a batch. Photographs not yet done become 'cancelled' (not failed: nobody is needed),
-- the job leaves the queue, and a pass already running ends by itself with nothing left to take. A photograph that
-- still lands after the cancel (it was mid-render) is done all the same.
alter table public.agent_job_photos drop constraint agent_job_photos_work_state_check;
alter table public.agent_job_photos add constraint agent_job_photos_work_state_check
  check (work_state in ('waiting', 'working', 'done', 'restock', 'failed', 'cancelled'));

create or replace function public.agent_job_sync_photos(p_job_id uuid)
returns void
language sql volatile security invoker set search_path = public, pg_temp
as $$
  update public.agent_job_photos p
     set work_state = case when p.restock_state is not null then 'restock' else 'done' end,
         worked_at = coalesce(p.worked_at, now()), last_error = null
   where p.job_id = p_job_id and p.work_state in ('waiting', 'working', 'failed', 'cancelled')
     and (p.restock_state is not null
          or exists (select 1 from public.intake_files f where f.agent_source_photo_id = p.id)
          or exists (select 1 from public.agent_jobs j
                      where j.id = p.job_id and j.kind = 'redo' and j.redo_of_intake_id is not null
                        and not exists (select 1 from public.intake_files f
                                         where f.id = j.redo_of_intake_id and f.reenhance_job_id = j.id)));
$$;

create function public.agent_job_cancel(p_job_id uuid, p_actor text)
returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_n   integer;
begin
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_cancel: no job %', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status = 'collecting' then
    raise exception 'agent_job_cancel: the batch was never sent' using errcode = '55000';
  end if;
  perform public.agent_job_sync_photos(p_job_id);
  update public.agent_job_photos set work_state = 'cancelled', last_error = null
   where job_id = p_job_id and status = 'uploaded' and work_state in ('waiting', 'working');
  get diagnostics v_n = row_count;
  -- A running pass reports its own end (agent_job_pass); with nothing waiting, that finishes the job.
  if v_job.status = 'queued' then
    update public.agent_jobs
       set status = case when exists (select 1 from public.agent_job_photos p where p.job_id = p_job_id and p.work_state in ('done', 'restock'))
                         then 'done' else 'failed' end,
           finished_at = now(), lease_until = null, not_before = null, hold_reason = null, error = null
     where id = p_job_id;
    if v_job.kind = 'redo' and v_job.redo_of_intake_id is not null then
      update public.intake_files set reenhance_job_id = null, reenhance_note = null
       where id = v_job.redo_of_intake_id and reenhance_job_id = p_job_id;
    end if;
  end if;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', p_job_id, 'agent_job.cancelled', jsonb_build_object('label', v_job.label, 'photos', v_n, 'was', v_job.status), btrim(p_actor));
  return v_n;
end;
$$;

revoke all on function public.agent_job_cancel(uuid, text) from public, anon, authenticated;
grant execute on function public.agent_job_cancel(uuid, text) to service_role;
