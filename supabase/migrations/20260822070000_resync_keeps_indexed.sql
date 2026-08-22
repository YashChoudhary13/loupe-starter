-- A second machine fetching its own copy of an already indexed reference (the laptop
-- syncing what the interim Mac worker embedded) must not drop the reference out of the
-- index or queue another embed: the vectors are already in pgvector. Sync completion now
-- keeps 'indexed' and only queues an embed for references that still need one.
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
       set status     = case when status = 'indexed' then 'indexed' else 'synced' end,
           synced_at  = now(),
           local_path = coalesce(p_result ->> 'local_path', local_path),
           sha256     = coalesce(p_result ->> 'sha256', sha256),
           last_error = null
     where id = v_job.reference_id;
    -- The embedding is the next step; when it runs is the worker's schedule
    -- (nightly on the laptop), not the queue's concern. A re-sync of an indexed
    -- reference needs no embed.
    insert into public.match_jobs (kind, reference_id)
    select 'embed', v_job.reference_id
     where not exists (
       select 1 from public.match_jobs
        where reference_id = v_job.reference_id and kind = 'embed' and status in ('queued', 'claimed'))
       and not exists (
       select 1 from public.match_references
        where id = v_job.reference_id and status = 'indexed');
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
