-- A restock decision also catches a photograph already queued for enhancement
-- (the non-blocking gate of 20260821190000) as long as the worker has not claimed it.
create or replace function public.decide_identification(
  p_match_event_id uuid,
  p_decision       text,
  p_sku            text,
  p_rank           smallint,
  p_actor          text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event public.match_events%rowtype;
  v_sku   text := nullif(upper(btrim(coalesce(p_sku, ''))), '');
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'decide_identification: p_actor is required' using errcode = '22023';
  end if;
  if p_decision not in ('new_product', 'restock', 'skipped') then
    raise exception 'decide_identification: % is not a decision for an intake photograph', p_decision
      using errcode = '22023';
  end if;
  if p_decision = 'restock' and v_sku is null then
    raise exception 'decide_identification: a restock names the SKU' using errcode = '22023';
  end if;

  select * into v_event from public.match_events where id = p_match_event_id for update;
  if not found then
    raise exception 'decide_identification: no match_event %', p_match_event_id
      using errcode = '22023';
  end if;
  if v_event.intake_file_id is null then
    raise exception 'decide_identification: event % is not an intake photograph', p_match_event_id
      using errcode = '22023';
  end if;
  if v_event.status = 'decided' then
    raise exception 'decide_identification: already decided' using errcode = '55000',
      hint = 'This photograph was already decided. Reload the page.';
  end if;

  update public.match_events
     set status      = 'decided',
         decision    = p_decision,
         chosen_sku  = case when p_decision = 'restock' then v_sku else null end,
         chosen_rank = case when p_decision = 'restock' then p_rank else null end,
         decided_at  = now(),
         decided_by  = p_actor
   where id = p_match_event_id;

  if p_decision = 'restock' then
    -- A restock decision stops the paid stages whether the photograph was
    -- waiting in Identify or (gate off, 20260821190000) already queued but not
    -- yet claimed by the enhancement worker.
    update public.intake_files
       set status = 'restock'
     where id = v_event.intake_file_id
       and status in ('identifying', 'discovered');

    insert into public.restock_decisions (intake_file_id, match_event_id, sku, created_by)
    values (v_event.intake_file_id, p_match_event_id, v_sku, p_actor)
    on conflict (intake_file_id) do nothing;
  else
    -- Back to the front of the enhancement queue, exactly as a fresh discovery.
    update public.intake_files
       set status          = 'discovered',
           next_attempt_at = now()
     where id = v_event.intake_file_id
       and status = 'identifying';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    v_event.intake_file_id,
    'match.decided',
    jsonb_strip_nulls(jsonb_build_object(
      'match_event_id', p_match_event_id,
      'decision', p_decision,
      'sku', v_sku,
      'rank', p_rank
    )),
    p_actor
  );
end;
$$;


revoke execute on function public.decide_identification(uuid, text, text, smallint, text) from public, anon, authenticated;
grant  execute on function public.decide_identification(uuid, text, text, smallint, text) to service_role;
