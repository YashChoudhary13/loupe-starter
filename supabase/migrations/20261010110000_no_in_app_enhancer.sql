-- D144: Loupe no longer enhances photographs. Claude renders outside Loupe and delivers finals
-- through /api/agent/images (D142) and the /enhance jobs (D143). Nothing may wait for the
-- retired worker any more: a photograph that used to be parked in `discovered` becomes an
-- ordinary enhanced intake with its original selected — exactly what finalize_manual_image_upload
-- produces — carrying a readable note so the operator knows it was never rendered.
--
-- No data is deleted. `discovered`/`enhancing` stay in the intake_status enum (history), the
-- prompts, app_config, image_redo_jobs and image_versions tables are untouched, and every
-- source='drive' row keeps its rows and events.

-- The one place the "enhanced with its original" transition now lives. Every photograph Loupe
-- still takes in arrived through an upload, so it has an R2 source key; the manual-upload
-- convention puts its thumbnail beside it as thumb.webp. A Drive-era row without a source key
-- cannot be shown, so it fails loudly with the same note instead of waiting for ever.
create or replace function public.select_original_as_enhanced(
  p_intake_file_id uuid,
  p_actor          text,
  p_reason         text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file  public.intake_files%rowtype;
  v_note  constant text := 'Not enhanced: send it through /enhance or upload a finished image.';
  v_thumb text;
begin
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'select_original_as_enhanced: no intake_file %', p_intake_file_id using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(v_file.source_storage_key, '')), '') is null then
    update public.intake_files
       set status             = 'failed',
           last_error         = 'Not enhanced: Loupe no longer enhances photographs, and this one has no stored copy (it came from the old Drive inbox). Upload it again through /enhance or Upload images.',
           last_error_code    = 'no_stored_source',
           last_error_detail  = null,
           error_class        = 'permanent',
           provider_paused_at = null,
           provider_pause_code = null,
           provider_pause_message = null,
           provider_pause_detail = null,
           lease_expires_at   = null,
           lease_token        = null
     where id = p_intake_file_id;
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('intake_file', p_intake_file_id, 'intake.failed',
            jsonb_build_object('reason', p_reason, 'code', 'no_stored_source', 'previous_status', v_file.status),
            btrim(p_actor));
    return;
  end if;

  v_thumb := left(v_file.source_storage_key, length(v_file.source_storage_key) - position('/' in reverse(v_file.source_storage_key))) || '/thumb.webp';

  insert into public.image_versions (intake_file_id, version_no, kind, storage_key, thumb_key, is_selected)
  values (p_intake_file_id, 0, 'original', v_file.source_storage_key, v_thumb, true)
  on conflict (intake_file_id, version_no) do update
     set is_selected = true,
         thumb_key   = coalesce(public.image_versions.thumb_key, excluded.thumb_key);
  update public.image_versions set is_selected = false
   where intake_file_id = p_intake_file_id and version_no <> 0 and is_selected;

  update public.intake_files
     set status             = 'enhanced',
         enhanced_at        = coalesce(enhanced_at, now()),
         next_attempt_at    = now(),
         last_error         = v_note,
         last_error_code    = 'not_enhanced',
         last_error_detail  = null,
         error_class        = null,
         provider_paused_at = null,
         provider_pause_code = null,
         provider_pause_message = null,
         provider_pause_detail = null,
         lease_expires_at   = null,
         lease_token        = null
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.original_selected',
          jsonb_build_object('reason', p_reason, 'previous_status', v_file.status, 'storage_key', v_file.source_storage_key, 'note', v_note),
          btrim(p_actor));
end;
$$;
comment on function public.select_original_as_enhanced(uuid, text, text) is
  'D144: the photograph goes to the console as it is (original selected, "Not enhanced" note) instead of waiting for the retired enhancement worker.';
revoke all on function public.select_original_as_enhanced(uuid, text, text) from public, anon, authenticated;
grant execute on function public.select_original_as_enhanced(uuid, text, text) to service_role;

-- Identify: "new product" and "skipped" used to send the photograph back to the enhancement queue.
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
    if v_file.status not in ('identifying', 'enhanced', 'grouped') then
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
    update public.intake_files
       set status           = 'restock',
           product_draft_id = null,
           grouped_at       = null
     where id = v_file.id;

    insert into public.restock_decisions (intake_file_id, match_event_id, sku, created_by)
    values (v_file.id, p_match_event_id, v_sku, p_actor)
    on conflict (intake_file_id) do nothing;
  elsif v_file.status = 'identifying' then
    -- D144: no enhancement queue to go back to. The photograph goes to the console as it is.
    perform public.select_original_as_enhanced(v_file.id, p_actor, 'identify:' || p_decision);
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

-- Restock: "new SKU with a new image" used to re-queue the photograph for the worker. The
-- signature is unchanged so the deployed app keeps calling it; a request for a new image now
-- means the same thing as no new image — the original is selected — because the render comes
-- from /enhance, not from here.
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

  if p_storage_key is not null and p_thumb_key is not null then
    insert into public.image_versions (intake_file_id, version_no, kind, storage_key, thumb_key, width, height, is_selected)
    values (p_intake_file_id, 0, 'original', p_storage_key, p_thumb_key, p_width, p_height, true)
    on conflict (intake_file_id, version_no) do update
       set is_selected = true, thumb_key = coalesce(public.image_versions.thumb_key, excluded.thumb_key);
    update public.intake_files
       set status = 'enhanced', enhanced_at = now()
     where id = p_intake_file_id;
  else
    -- D144: nothing to wait for; the stored original is selected.
    perform public.select_original_as_enhanced(p_intake_file_id, p_actor, 'restock:new_sku');
  end if;

  update public.restock_decisions
     set path = 'new_sku_archive_old', old_shopify_product_id = p_old_product_id,
         wants_new_image = false, preset_slug = null,
         status = 'draft_created', last_error = null
   where id = v_decision.id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'restock.new_sku_started',
          jsonb_strip_nulls(jsonb_build_object('decision_id', v_decision.id, 'replaces_sku', v_decision.sku,
                            'wants_new_image', false)), p_actor);
end;
$$;

-- On hold → resume used to mean "back to the front of the enhancement queue".
create or replace function public.resume_intake_file(
  p_intake_file_id uuid,
  p_actor          text
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'resume_intake_file: p_actor is required' using errcode = '22023';
  end if;

  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'resume_intake_file: no intake_file %', p_intake_file_id
      using errcode = '22023';
  end if;

  if v_file.status <> 'skipped' then
    raise exception 'resume_intake_file: only work on hold can be resumed, not %', v_file.status
      using errcode = '55000',
            hint    = 'Only a photograph that was put on hold can be picked back up.';
  end if;

  -- D144: back to the console as it is. If it already had versions (it was enhanced before the
  -- hold), the selected one stays selected and no note is added.
  if exists (select 1 from public.image_versions where intake_file_id = p_intake_file_id and is_selected) then
    update public.intake_files
       set status = 'enhanced', attempts = 0, next_attempt_at = now(),
           last_error = null, last_error_code = null, last_error_detail = null, error_class = null,
           lease_expires_at = null, lease_token = null
     where id = p_intake_file_id;
  else
    perform public.select_original_as_enhanced(p_intake_file_id, p_actor, 'resume');
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.resumed',
          jsonb_build_object('previous_status', v_file.status), p_actor);
end;
$$;

-- Nothing stays stranded: every row still waiting for the worker is converted now.
do $$
declare
  r record;
begin
  for r in
    select id from public.intake_files
     where status in ('discovered', 'enhancing')
     order by discovered_at
  loop
    perform public.select_original_as_enhanced(r.id, 'migration:D144', 'no_in_app_enhancer');
  end loop;
end;
$$;
