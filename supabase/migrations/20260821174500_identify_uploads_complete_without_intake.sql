-- An identify upload (D110) completes without an intake row: it is a question,
-- not queue work. The completion constraint from 20260803120000 assumed every
-- completed upload became an intake row; it now admits target = 'identify'.

alter table public.manual_uploads drop constraint if exists manual_uploads_completion_is_consistent;
alter table public.manual_uploads add constraint manual_uploads_completion_is_consistent check (
  (status = 'pending' and intake_file_id is null and completed_at is null and error is null)
  or (status = 'completed' and completed_at is not null and error is null
      and (intake_file_id is not null or target = 'identify'))
  or (status = 'failed' and intake_file_id is null and completed_at is null and error is not null)
);

create or replace function public.finalize_identify_upload(
  p_upload_id uuid,
  p_thumb_key text,
  p_phash     text,
  p_actor     text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_upload   public.manual_uploads%rowtype;
  v_event_id uuid;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'finalize_identify_upload: p_actor is required' using errcode = '22023';
  end if;

  select * into v_upload from public.manual_uploads where id = p_upload_id for update;
  if not found then
    raise exception 'finalize_identify_upload: no upload %', p_upload_id using errcode = '22023';
  end if;
  if v_upload.target <> 'identify' then
    raise exception 'finalize_identify_upload: upload % is a % upload', p_upload_id, v_upload.target
      using errcode = '22023';
  end if;
  if v_upload.status = 'completed' then
    select e.id into v_event_id from public.match_events as e
     where e.surface = 'identify' and e.query_storage_key = v_upload.storage_key
     order by e.created_at desc limit 1;
    if v_event_id is not null then
      return v_event_id;
    end if;
  elsif v_upload.status <> 'pending' then
    raise exception 'finalize_identify_upload: upload % is %', p_upload_id, v_upload.status
      using errcode = '55000', hint = 'Take the photograph again.';
  end if;

  insert into public.match_events (surface, query_storage_key, thumb_key, status)
  values ('identify', v_upload.storage_key, p_thumb_key, 'queued')
  returning id into v_event_id;

  insert into public.match_jobs (kind, match_event_id) values ('identify', v_event_id);

  update public.manual_uploads
     set status = 'completed', completed_at = now()
   where id = p_upload_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'match_event', v_event_id, 'match.requested',
    jsonb_build_object('match_event_id', v_event_id, 'surface', 'identify',
                       'filename', v_upload.filename, 'bytes', v_upload.bytes, 'phash', p_phash),
    p_actor
  );

  return v_event_id;
end;
$$;

-- The worker's thumbnail of a query (a Drive photograph Loupe has no bytes for),
-- recorded only by the worker holding the live lease.
create or replace function public.record_match_thumb(
  p_job       uuid,
  p_token     uuid,
  p_thumb_key text
)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  update public.match_events as e
     set thumb_key = coalesce(e.thumb_key, p_thumb_key)
    from public.match_jobs as j
   where j.id = p_job and j.match_event_id = e.id
     and j.status = 'claimed' and j.lease_token = p_token and j.lease_expires_at >= now();
$$;

revoke execute on function public.finalize_identify_upload(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.finalize_identify_upload(uuid, text, text, text) to service_role;
revoke execute on function public.record_match_thumb(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.record_match_thumb(uuid, uuid, text) to service_role;
