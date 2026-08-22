-- 2026-08-22: while the gate was non-blocking (20260821190000) every photograph
-- was enhanced and grouped before anyone could decide; a restock decided on one
-- of those recorded the decision but left the photograph 'grouped' — invisible
-- to the Restock screen (which lists intake_files in 'restock') and still heading
-- to Shopify as a new product. A restock now also stops an enhanced or grouped
-- photograph: it leaves its draft (detach_intake_file, D64), and a draft that is
-- left empty and never reached Shopify is deleted with its number freed (D101).
-- A draft that already has a Shopify draft product stays for the operator to
-- delete in the console; its id is in the match.decided event.
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
  v_event  public.match_events%rowtype;
  v_file   public.intake_files%rowtype;
  v_draft  public.product_drafts%rowtype;
  v_sku    text := nullif(upper(btrim(coalesce(p_sku, ''))), '');
  v_left   uuid;   -- a draft left behind with a Shopify draft product, for the operator
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

  select * into v_file from public.intake_files where id = v_event.intake_file_id for update;
  if not found then
    raise exception 'decide_identification: photograph % no longer exists', v_event.intake_file_id
      using errcode = '22023';
  end if;

  if p_decision = 'restock' then
    if v_file.status = 'enhancing' then
      raise exception 'decide_identification: % is being enhanced right now', v_file.filename
        using errcode = '55000',
              hint    = 'The enhancement finishes within a minute. Reload Identify and decide again.';
    end if;
    if v_file.status not in ('identifying', 'discovered', 'enhanced', 'grouped') then
      raise exception 'decide_identification: % is % and cannot become a restock', v_file.filename, v_file.status
        using errcode = '55000',
              hint    = 'Only a photograph that has not been published can be marked as a restock.';
    end if;
    if v_file.status = 'grouped' and v_file.product_draft_id is not null then
      select * into v_draft from public.product_drafts where id = v_file.product_draft_id for update;
      if v_draft.status = 'publishing'
         or (v_draft.publish_lease_expires_at is not null and v_draft.publish_lease_expires_at > now()) then
        raise exception 'decide_identification: the product holding % is being published', v_file.filename
          using errcode = '55000',
                hint    = 'Wait for the publish to finish, then handle the restock from the console.';
      end if;
      perform public.detach_intake_file(v_draft.id, v_file.id, p_actor);
      if not exists (select 1 from public.intake_files where product_draft_id = v_draft.id) then
        if v_draft.status in ('assembling', 'failed') and v_draft.shopify_product_id is null then
          if v_draft.reserved_sku is not null then
            perform public.release_draft_identity(v_draft.id, null, p_actor);
          end if;
          insert into public.events (entity_type, entity_id, event, detail, actor)
          values ('product_draft', v_draft.id, 'draft.deleted_after_restock',
                  jsonb_strip_nulls(jsonb_build_object(
                    'reserved_sku', v_draft.reserved_sku,
                    'intake_file_id', v_file.id,
                    'match_event_id', p_match_event_id)),
                  p_actor);
          delete from public.product_drafts where id = v_draft.id;
        else
          v_left := v_draft.id;
        end if;
      end if;
    end if;
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
    -- Stops the paid stages whether the photograph was waiting in Identify,
    -- queued but unclaimed, or already enhanced (detached above).
    update public.intake_files
       set status           = 'restock',
           product_draft_id = null,
           grouped_at       = null
     where id = v_file.id;

    insert into public.restock_decisions (intake_file_id, match_event_id, sku, created_by)
    values (v_file.id, p_match_event_id, v_sku, p_actor)
    on conflict (intake_file_id) do nothing;
  else
    -- Back to the front of the enhancement queue, exactly as a fresh discovery.
    update public.intake_files
       set status          = 'discovered',
           next_attempt_at = now()
     where id = v_file.id
       and status = 'identifying';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    v_file.id,
    'match.decided',
    jsonb_strip_nulls(jsonb_build_object(
      'match_event_id', p_match_event_id,
      'decision', p_decision,
      'sku', v_sku,
      'rank', p_rank,
      'was', v_file.status,
      'empty_draft_left', v_left
    )),
    p_actor
  );
end;
$$;

comment on function public.decide_identification(uuid, text, text, smallint, text) is
  'The operator''s decision on an intake photograph (D110): new_product or skipped sends it to enhancement; restock stops it — also after enhancement, leaving its draft (D64) and deleting an emptied never-sent draft (D101) — and opens a restock decision.';

revoke execute on function public.decide_identification(uuid, text, text, smallint, text) from public, anon, authenticated;
grant  execute on function public.decide_identification(uuid, text, text, smallint, text) to service_role;
