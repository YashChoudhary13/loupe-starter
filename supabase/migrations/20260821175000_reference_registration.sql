-- D111: every published product's original becomes a matcher reference.
--
-- register_reference() is the one way a reference row is born for a Loupe
-- photograph (publish, restock, confirmed identify all use it); it is
-- idempotent per intake file. register_published_originals() is the sweep that
-- catches every published product without a reference — called right after a
-- publish and weekly by cron, the same self-healing shape as the Drive backlog
-- tidy-up (D92): keyed on state, not on an event.

create or replace function public.register_reference(
  p_intake_file_id uuid,
  p_sku            text,
  p_handle         text,
  p_title          text,
  p_storage_key    text,
  p_source         text,
  p_actor          text,
  p_match_event_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_sku is null or btrim(p_sku) = '' then
    raise exception 'register_reference: p_sku is required' using errcode = '22023';
  end if;
  if p_storage_key is null or btrim(p_storage_key) = '' then
    raise exception 'register_reference: p_storage_key is required' using errcode = '22023';
  end if;
  if p_source not in ('loupe_original', 'restock', 'identify_confirmed') then
    raise exception 'register_reference: % is not a Loupe reference source', p_source using errcode = '22023';
  end if;

  if p_intake_file_id is not null then
    select id into v_id from public.match_references where intake_file_id = p_intake_file_id;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  insert into public.match_references (sku, handle, title, storage_key, source, intake_file_id, match_event_id, status, added_by)
  values (upper(btrim(p_sku)), p_handle, p_title, p_storage_key, p_source, p_intake_file_id, p_match_event_id, 'pending_sync', p_actor)
  returning id into v_id;

  insert into public.match_jobs (kind, reference_id) values ('sync', v_id);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    coalesce(case when p_intake_file_id is not null then 'intake_file' end, 'match_reference'),
    coalesce(p_intake_file_id, v_id),
    'match.reference_added',
    jsonb_strip_nulls(jsonb_build_object('reference_id', v_id, 'sku', upper(btrim(p_sku)), 'source', p_source,
                                         'storage_key', p_storage_key, 'match_event_id', p_match_event_id)),
    p_actor
  );
  return v_id;
end;
$$;

comment on function public.register_reference(uuid, text, text, text, text, text, text, uuid) is
  'Registers one photograph as a matcher reference for a SKU and queues its sync to the laptop. Idempotent per intake file (D111).';

-- Every published product whose original is still in R2 and not yet registered.
-- Products whose original is gone (purged before D109, or a ready image with no
-- raw) are skipped: the backfill script covers Drive-only originals by copying
-- them into references/ first.
create or replace function public.register_published_originals(
  p_limit integer default 200,
  p_actor text default 'cron:match-register'
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select f.id as intake_file_id, d.reserved_sku, d.reserved_handle, iv.storage_key
      from public.product_drafts as d
      join public.intake_files   as f  on f.product_draft_id = d.id
      join public.image_versions as iv on iv.intake_file_id = f.id and iv.kind = 'original' and iv.purged_at is null
     where d.status = 'published'
       and d.reserved_sku is not null
       and f.source <> 'manual'
       and not exists (select 1 from public.match_references as r where r.intake_file_id = f.id)
     order by d.published_at
     limit p_limit
  loop
    perform public.register_reference(v_row.intake_file_id, v_row.reserved_sku, v_row.reserved_handle, null,
                                      v_row.storage_key, 'loupe_original', p_actor);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.register_published_originals(integer, text) is
  'Registers the originals of published products that have none yet (ready images excluded: they are not photographs of stock). Safe to run any time (D111).';

revoke execute on function public.register_reference(uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant  execute on function public.register_reference(uuid, text, text, text, text, text, text, uuid) to service_role;
revoke execute on function public.register_published_originals(integer, text) from public, anon, authenticated;
grant  execute on function public.register_published_originals(integer, text) to service_role;
