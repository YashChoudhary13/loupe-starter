-- 2026-08-23: a restock photograph the operator handled by hand (they corrected the
-- SKU because price/material did not match, and set stock themselves) still deserves
-- to become a matcher reference for that SKU. This is complete_restock_existing minus
-- the inventory/Shopify write, and it takes an explicit SKU so the operator can save
-- the photograph under the corrected number rather than the one the matcher guessed.
create or replace function public.save_restock_reference(
  p_decision_id   uuid,
  p_sku           text,
  p_reference_key text,
  p_actor         text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision public.restock_decisions%rowtype;
  v_sku      text := coalesce(nullif(upper(btrim(coalesce(p_sku, ''))), ''), null);
  v_ref_id   uuid;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'save_restock_reference: p_actor is required' using errcode = '22023';
  end if;
  if p_reference_key is null or btrim(p_reference_key) = '' then
    raise exception 'save_restock_reference: p_reference_key is required' using errcode = '22023';
  end if;

  select * into v_decision from public.restock_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'save_restock_reference: no decision %', p_decision_id using errcode = '22023';
  end if;
  if v_decision.status = 'completed' then
    -- Already handled; hand back the reference that exists for this photograph.
    return (select id from public.match_references where intake_file_id = v_decision.intake_file_id);
  end if;

  v_sku := coalesce(v_sku, v_decision.sku);

  update public.restock_decisions
     set status = 'completed', completed_at = now(), last_error = null,
         sku = v_sku
   where id = p_decision_id;

  update public.intake_files
     set status = 'restocked'
   where id = v_decision.intake_file_id
     and status = 'restock';

  v_ref_id := public.register_reference(v_decision.intake_file_id, v_sku, null, null,
                                        p_reference_key, 'restock', p_actor, v_decision.match_event_id);
  update public.match_events set reference_id = v_ref_id
   where id = v_decision.match_event_id and reference_id is null;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', v_decision.intake_file_id, 'restock.reference_saved',
          jsonb_strip_nulls(jsonb_build_object(
            'decision_id', p_decision_id, 'sku', v_sku,
            'corrected_from', case when v_sku <> v_decision.sku then v_decision.sku end,
            'reference_id', v_ref_id, 'reference_only', true)),
          p_actor);
  return v_ref_id;
end;
$$;

comment on function public.save_restock_reference(uuid, text, text, text) is
  'Saves a restock photograph as a matcher reference for a SKU (operator-corrected if given) without any Shopify inventory write, marks the decision completed and the photograph restocked (2026-08-23).';

revoke execute on function public.save_restock_reference(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.save_restock_reference(uuid, text, text, text) to service_role;
