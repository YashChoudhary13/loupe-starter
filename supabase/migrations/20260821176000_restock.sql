-- D112: what happens after an operator confirms a photograph is a restock.
--
-- Two paths, both chosen by a human in the Restock section:
--   restock_existing      stock on the existing product is set in Shopify; the
--                         photograph becomes a reference; the intake row ends
--                         as 'restocked'.
--   new_sku_archive_old   the photograph re-enters the normal pipeline (with a
--                         new generated image, or as it is); when the new
--                         product publishes, the old one is archived and its
--                         stock zeroed (record_supersession), so no two active
--                         listings carry the same piece.
-- Shopify writes happen in TypeScript between begin_* and complete_*; these
-- functions only move Loupe's state and refuse to move it twice.

create or replace function public.begin_restock_existing(
  p_intake_file_id   uuid,
  p_old_product_id   text,
  p_quantities       jsonb,
  p_actor            text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision public.restock_decisions%rowtype;
begin
  select * into v_decision from public.restock_decisions where intake_file_id = p_intake_file_id for update;
  if not found then
    raise exception 'begin_restock_existing: no restock decision for %', p_intake_file_id using errcode = '22023';
  end if;
  if v_decision.status = 'completed' then
    raise exception 'begin_restock_existing: already completed' using errcode = '55000',
      hint = 'This restock was already applied. Reload the page.';
  end if;
  update public.restock_decisions
     set path = 'restock_existing', old_shopify_product_id = p_old_product_id, quantities = p_quantities,
         status = 'pending', last_error = null
   where id = v_decision.id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'restock.started',
          jsonb_build_object('decision_id', v_decision.id, 'sku', v_decision.sku, 'path', 'restock_existing', 'quantities', p_quantities), p_actor);
  return v_decision.id;
end;
$$;

create or replace function public.complete_restock_existing(
  p_decision_id    uuid,
  p_reference_key  text,
  p_actor          text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision public.restock_decisions%rowtype;
  v_file     public.intake_files%rowtype;
  v_ref_id   uuid;
begin
  select * into v_decision from public.restock_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'complete_restock_existing: no decision %', p_decision_id using errcode = '22023';
  end if;
  if v_decision.status = 'completed' then
    return;
  end if;
  select * into v_file from public.intake_files where id = v_decision.intake_file_id for update;

  update public.restock_decisions
     set status = 'completed', completed_at = now(), last_error = null
   where id = p_decision_id;

  update public.intake_files
     set status = 'restocked'
   where id = v_decision.intake_file_id
     and status = 'restock';

  -- The restock photograph is a real photograph of that exact SKU, taken here:
  -- the best reference the index can have.
  v_ref_id := public.register_reference(v_decision.intake_file_id, v_decision.sku, null, null,
                                        p_reference_key, 'restock', p_actor, v_decision.match_event_id);
  update public.match_events set reference_id = v_ref_id where id = v_decision.match_event_id and reference_id is null;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', v_decision.intake_file_id, 'restock.completed',
          jsonb_build_object('decision_id', p_decision_id, 'sku', v_decision.sku, 'quantities', v_decision.quantities,
                             'reference_id', v_ref_id), p_actor);
end;
$$;

create or replace function public.fail_restock(
  p_decision_id uuid,
  p_error       text,
  p_actor       text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision public.restock_decisions%rowtype;
begin
  select * into v_decision from public.restock_decisions where id = p_decision_id for update;
  if not found or v_decision.status = 'completed' then
    return;
  end if;
  update public.restock_decisions set status = 'failed', last_error = left(p_error, 2000) where id = p_decision_id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', v_decision.intake_file_id, 'restock.failed',
          jsonb_build_object('decision_id', p_decision_id, 'sku', v_decision.sku, 'error', left(p_error, 500)), p_actor);
end;
$$;

-- Path B. The photograph goes back into the pipeline: with a new generated
-- image (status 'discovered', carrying the chosen prompt pair, D103), or as it
-- is (status 'enhanced', the original as the selected version — the same shape
-- as a ready image). The supersession itself happens at publish.
create or replace function public.begin_new_sku_from_restock(
  p_intake_file_id  uuid,
  p_old_product_id  text,
  p_wants_new_image boolean,
  p_preset_slug     text,
  p_storage_key     text,
  p_thumb_key       text,
  p_width           integer,
  p_height          integer,
  p_actor           text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision public.restock_decisions%rowtype;
  v_file     public.intake_files%rowtype;
begin
  select * into v_decision from public.restock_decisions where intake_file_id = p_intake_file_id for update;
  if not found then
    raise exception 'begin_new_sku_from_restock: no restock decision for %', p_intake_file_id using errcode = '22023';
  end if;
  if v_decision.status in ('completed', 'draft_created') then
    raise exception 'begin_new_sku_from_restock: already decided' using errcode = '55000',
      hint = 'This photograph is already on its way to a new SKU. Reload the page.';
  end if;
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if v_file.status <> 'restock' then
    raise exception 'begin_new_sku_from_restock: photograph is %, not restock', v_file.status using errcode = '55000';
  end if;

  if coalesce(p_wants_new_image, false) then
    update public.intake_files
       set status = 'discovered', next_attempt_at = now(), attempts = 0,
           preset_slug = coalesce(nullif(btrim(coalesce(p_preset_slug, '')), ''), preset_slug)
     where id = p_intake_file_id;
  else
    if p_storage_key is null or p_thumb_key is null then
      raise exception 'begin_new_sku_from_restock: the original''s storage and thumbnail keys are required without a new image'
        using errcode = '22023';
    end if;
    insert into public.image_versions (intake_file_id, version_no, kind, storage_key, thumb_key, width, height, is_selected)
    values (p_intake_file_id, 0, 'original', p_storage_key, p_thumb_key, p_width, p_height, true)
    on conflict (intake_file_id, version_no) do update
       set is_selected = true, thumb_key = coalesce(public.image_versions.thumb_key, excluded.thumb_key);
    update public.intake_files
       set status = 'enhanced', enhanced_at = now()
     where id = p_intake_file_id;
  end if;

  update public.restock_decisions
     set path = 'new_sku_archive_old', old_shopify_product_id = p_old_product_id,
         wants_new_image = coalesce(p_wants_new_image, false), preset_slug = p_preset_slug,
         status = 'draft_created', last_error = null
   where id = v_decision.id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'restock.new_sku_started',
          jsonb_strip_nulls(jsonb_build_object('decision_id', v_decision.id, 'replaces_sku', v_decision.sku,
                            'wants_new_image', coalesce(p_wants_new_image, false), 'preset_slug', p_preset_slug)), p_actor);
end;
$$;

-- Which old product a draft replaces, if any: the photographs it contains carry
-- an undone new-SKU restock decision. Read at publish.
create or replace function public.pending_supersession(p_draft_id uuid)
returns table (decision_id uuid, old_sku text, old_shopify_product_id text)
language sql
stable
set search_path = public, pg_temp
as $$
  select rd.id, rd.sku, rd.old_shopify_product_id
    from public.restock_decisions as rd
    join public.intake_files as f on f.id = rd.intake_file_id
   where f.product_draft_id = p_draft_id
     and rd.path = 'new_sku_archive_old'
     and rd.status <> 'completed'
   order by rd.created_at
   limit 1;
$$;

create or replace function public.record_supersession(
  p_draft_id        uuid,
  p_decision_id     uuid,
  p_old_product_id  text,
  p_actor           text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision public.restock_decisions%rowtype;
begin
  select * into v_decision from public.restock_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'record_supersession: no decision %', p_decision_id using errcode = '22023';
  end if;
  update public.restock_decisions
     set status = 'completed', completed_at = now(), new_draft_id = p_draft_id,
         old_shopify_product_id = coalesce(p_old_product_id, old_shopify_product_id), last_error = null
   where id = p_decision_id;
  update public.product_drafts set supersedes_sku = v_decision.sku where id = p_draft_id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'product.superseded',
          jsonb_build_object('old_sku', v_decision.sku, 'old_shopify_product_id', coalesce(p_old_product_id, v_decision.old_shopify_product_id),
                             'decision_id', p_decision_id), p_actor);
end;
$$;

-- "Not this one": back to Identify. The old decision stays as history; a
-- match.reopened event marks it as withdrawn.
create or replace function public.reopen_identification(
  p_intake_file_id uuid,
  p_actor          text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_decision public.restock_decisions%rowtype;
begin
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found or v_file.status <> 'restock' then
    raise exception 'reopen_identification: only a photograph waiting in Restock can go back to Identify'
      using errcode = '55000';
  end if;
  select * into v_decision from public.restock_decisions where intake_file_id = p_intake_file_id for update;
  if found and v_decision.status in ('completed', 'draft_created') then
    raise exception 'reopen_identification: this restock was already applied' using errcode = '55000';
  end if;
  delete from public.restock_decisions where intake_file_id = p_intake_file_id;
  update public.intake_files set status = 'identifying' where id = p_intake_file_id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'match.reopened',
          jsonb_build_object('withdrawn_match_event_id', v_decision.match_event_id, 'withdrawn_sku', v_decision.sku), p_actor);
  return public.request_identification(p_intake_file_id, case when v_file.source = 'drive' then 'drive' else 'upload' end, p_actor);
end;
$$;

revoke execute on function public.begin_restock_existing(uuid, text, jsonb, text) from public, anon, authenticated;
grant  execute on function public.begin_restock_existing(uuid, text, jsonb, text) to service_role;
revoke execute on function public.complete_restock_existing(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.complete_restock_existing(uuid, text, text) to service_role;
revoke execute on function public.fail_restock(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.fail_restock(uuid, text, text) to service_role;
revoke execute on function public.begin_new_sku_from_restock(uuid, text, boolean, text, text, text, integer, integer, text) from public, anon, authenticated;
grant  execute on function public.begin_new_sku_from_restock(uuid, text, boolean, text, text, text, integer, integer, text) to service_role;
revoke execute on function public.pending_supersession(uuid) from public, anon, authenticated;
grant  execute on function public.pending_supersession(uuid) to service_role;
revoke execute on function public.record_supersession(uuid, uuid, text, text) from public, anon, authenticated;
grant  execute on function public.record_supersession(uuid, uuid, text, text) to service_role;
revoke execute on function public.reopen_identification(uuid, text) from public, anon, authenticated;
grant  execute on function public.reopen_identification(uuid, text) to service_role;
