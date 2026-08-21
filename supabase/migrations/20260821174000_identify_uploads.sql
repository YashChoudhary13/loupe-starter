-- D110: the standalone Identify screen. A photograph taken on the warehouse
-- floor is uploaded through the same presigned handshake as ready images and
-- raw uploads (manual_uploads, target = 'identify'), becomes a match event with
-- no intake row, and — only after a human confirms which SKU it shows — becomes
-- a reference the matcher will learn from.

alter table public.manual_uploads drop constraint if exists manual_uploads_target_check;
alter table public.manual_uploads
  add constraint manual_uploads_target_check check (target in ('ready', 'raw', 'identify'));

-- A small thumbnail of the query, written by /api/worker/complete from the
-- worker's result, so the Identify screen can show a Drive photograph Loupe
-- has never otherwise had bytes for.
alter table public.match_events add column if not exists thumb_key text;

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

  update public.manual_uploads set status = 'completed' where id = p_upload_id;

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

comment on function public.finalize_identify_upload(uuid, text, text, text) is
  'Turns a verified warehouse photograph into a match event and an identify job, with no intake row (D110).';

-- The decision on an identify photograph. A confirmation makes the photograph a
-- reference for that SKU — after the human said so, never before.
create or replace function public.confirm_identification(
  p_match_event_id uuid,
  p_decision       text,
  p_sku            text,
  p_rank           smallint,
  p_actor          text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event  public.match_events%rowtype;
  v_sku    text := nullif(upper(btrim(coalesce(p_sku, ''))), '');
  v_ref_id uuid;
  v_handle text;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'confirm_identification: p_actor is required' using errcode = '22023';
  end if;
  if p_decision not in ('confirmed', 'none_of_these') then
    raise exception 'confirm_identification: % is not a decision for an identify photograph', p_decision
      using errcode = '22023';
  end if;
  if p_decision = 'confirmed' and v_sku is null then
    raise exception 'confirm_identification: a confirmation names the SKU' using errcode = '22023';
  end if;

  select * into v_event from public.match_events where id = p_match_event_id for update;
  if not found then
    raise exception 'confirm_identification: no match_event %', p_match_event_id using errcode = '22023';
  end if;
  if v_event.surface <> 'identify' then
    raise exception 'confirm_identification: event % is an intake photograph; use decide_identification', p_match_event_id
      using errcode = '22023';
  end if;
  if v_event.status = 'decided' then
    raise exception 'confirm_identification: already decided' using errcode = '55000',
      hint = 'This photograph was already decided. Reload the page.';
  end if;

  if p_decision = 'confirmed' then
    select c ->> 'handle' into v_handle
      from jsonb_array_elements(coalesce(v_event.candidates, '[]'::jsonb)) as c
     where c ->> 'sku' = v_sku limit 1;

    insert into public.match_references (sku, handle, storage_key, source, match_event_id, status, added_by)
    values (v_sku, v_handle, v_event.query_storage_key, 'identify_confirmed', p_match_event_id, 'pending_sync', p_actor)
    returning id into v_ref_id;

    insert into public.match_jobs (kind, reference_id) values ('sync', v_ref_id);

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('match_event', p_match_event_id, 'match.reference_added',
            jsonb_build_object('reference_id', v_ref_id, 'sku', v_sku, 'source', 'identify_confirmed'), p_actor);
  end if;

  update public.match_events
     set status       = 'decided',
         decision     = p_decision,
         chosen_sku   = case when p_decision = 'confirmed' then v_sku else null end,
         chosen_rank  = case when p_decision = 'confirmed' then p_rank else null end,
         decided_at   = now(),
         decided_by   = p_actor,
         reference_id = v_ref_id
   where id = p_match_event_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('match_event', p_match_event_id, 'match.decided',
          jsonb_strip_nulls(jsonb_build_object('decision', p_decision, 'sku', v_sku, 'rank', p_rank)), p_actor);

  return v_ref_id;
end;
$$;

comment on function public.confirm_identification(uuid, text, text, smallint, text) is
  'Records the decision on a warehouse photograph. A confirmation registers it as a reference for that SKU, pending sync to the laptop; nothing is learned from an unconfirmed match (D110).';

revoke execute on function public.finalize_identify_upload(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.finalize_identify_upload(uuid, text, text, text) to service_role;
revoke execute on function public.confirm_identification(uuid, text, text, smallint, text) from public, anon, authenticated;
grant  execute on function public.confirm_identification(uuid, text, text, smallint, text) to service_role;
