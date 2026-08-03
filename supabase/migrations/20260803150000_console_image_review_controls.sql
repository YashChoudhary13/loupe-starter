-- Console image review controls.
--
-- 1. A catalogue-ready manual upload may deliberately enter the image-model
--    path later. It uses the existing durable redo job, with the same generic
--    fallback used after an unavailable describer; this is an image-only call.
-- 2. An ungrouped photograph may be deleted from the console, but the claim is
--    made atomically before Drive/R2 cleanup and is refused once any Shopify-
--    sent draft has ever owned that photograph.

-- A deleted manual intake should remove its completed upload handshake too.
-- The durable events row remains the audit trail after both operational rows
-- are intentionally gone.
alter table public.manual_uploads
  drop constraint manual_uploads_intake_file_id_fkey;

alter table public.manual_uploads
  add constraint manual_uploads_intake_file_id_fkey
  foreign key (intake_file_id)
  references public.intake_files (id)
  on delete cascade;

create or replace function public.prepare_manual_image_redo(
  p_intake_file_id uuid,
  p_actor text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_changed boolean := false;
begin
  if p_intake_file_id is null then
    raise exception 'prepare_manual_image_redo: intake file id is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'prepare_manual_image_redo: actor is required'
      using errcode = '22023';
  end if;

  select *
    into v_file
    from public.intake_files
   where id = p_intake_file_id
   for update;

  if not found then
    raise exception 'prepare_manual_image_redo: no intake file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.source <> 'manual' then
    return false;
  end if;
  if v_file.status not in ('enhanced', 'grouped') then
    raise exception 'prepare_manual_image_redo: manual image % is %', p_intake_file_id, v_file.status
      using errcode = '55000',
            hint = 'AI enhancement is available before the photograph is published.';
  end if;

  v_changed := v_file.presentation_class is null
    or (v_file.product_description is null and v_file.description_missing_at is null);

  update public.intake_files
     set presentation_class = coalesce(
           presentation_class,
           'flat-curve'::public.presentation_class
         ),
         presentation_fallback = case
           when presentation_class is null then true
           else presentation_fallback
         end,
         presentation_fallback_reason = case
           when presentation_class is null then 'manual_ready_upload_image_only_ai'
           else presentation_fallback_reason
         end,
         description_missing_at = case
           when product_description is null then coalesce(description_missing_at, now())
           else description_missing_at
         end
   where id = p_intake_file_id;

  if v_changed then
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'intake_file',
      p_intake_file_id,
      'intake.manual_ai_enabled',
      jsonb_build_object(
        'image_only', true,
        'description_missing', v_file.product_description is null,
        'presentation_fallback', v_file.presentation_class is null
      ),
      btrim(p_actor)
    );
  end if;

  return true;
end;
$$;

comment on function public.prepare_manual_image_redo(uuid, text) is
  'Idempotently settles a manual ready upload for the existing durable image-only redo path. It never calls the describer and refuses published work.';

revoke all on function public.prepare_manual_image_redo(uuid, text)
  from public, anon, authenticated;
grant execute on function public.prepare_manual_image_redo(uuid, text)
  to service_role;

create or replace function public.prepare_console_photo_delete(
  p_intake_file_id uuid,
  p_actor text
)
returns public.intake_status
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_intake_file_id is null then
    raise exception 'prepare_console_photo_delete: intake file id is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'prepare_console_photo_delete: actor is required'
      using errcode = '22023';
  end if;

  select *
    into v_file
    from public.intake_files
   where id = p_intake_file_id
   for update;

  if not found then
    raise exception 'prepare_console_photo_delete: no intake file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.product_draft_id is not null or v_file.status in ('grouped', 'published') then
    raise exception 'prepare_console_photo_delete: photograph % belongs to a product', p_intake_file_id
      using errcode = '55000',
            hint = 'This photograph belongs to a product draft. It cannot be deleted from the console.';
  end if;
  if v_file.status not in ('enhanced', 'skipped') then
    raise exception 'prepare_console_photo_delete: photograph % is %', p_intake_file_id, v_file.status
      using errcode = '55000',
            hint = 'Only an ungrouped photograph that is ready in the console can be deleted.';
  end if;

  if exists (
    select 1
      from public.events e
      join public.product_drafts d
        on d.id = (e.detail->>'product_draft_id')::uuid
     where e.entity_type = 'intake_file'
       and e.entity_id = p_intake_file_id
       and e.event = 'intake.grouped'
       and d.shopify_first_sent_at is not null
  ) then
    raise exception 'prepare_console_photo_delete: photograph % has already reached Shopify', p_intake_file_id
      using errcode = '55000',
            hint = 'This photograph has already been sent to Shopify. Delete or change it from Shopify instead.';
  end if;

  if v_file.status = 'enhanced' then
    update public.intake_files
       set status = 'skipped',
           lease_token = null,
           lease_expires_at = null,
           next_attempt_at = now()
     where id = p_intake_file_id;

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'intake_file',
      p_intake_file_id,
      'intake.console_delete_requested',
      jsonb_build_object('source', v_file.source, 'filename', v_file.filename),
      btrim(p_actor)
    );
  end if;

  return 'skipped'::public.intake_status;
end;
$$;

comment on function public.prepare_console_photo_delete(uuid, text) is
  'Atomically removes an enhanced ungrouped photograph from the grouping race before external cleanup. Refuses current draft members and anything ever sent to Shopify.';

revoke all on function public.prepare_console_photo_delete(uuid, text)
  from public, anon, authenticated;
grant execute on function public.prepare_console_photo_delete(uuid, text)
  to service_role;
