-- D178: a photograph that is in no product now can be deleted from the Console, even when it
-- once belonged to a product that was sent to Shopify.
--
-- The owner had 13 photographs in Pending that no delete could remove: each had been part of a
-- listed product (ER1001, ER1058 to ER1061, ER1077, ER1079, ER1080, WH093) and was taken out of
-- it later. D74 refused those forever. Shopify serves its own copy of every picture it was sent,
-- so removing Loupe's copy changes nothing on the store; the intake.discarded event keeps the
-- filename as the record. A photograph still in a draft or a published product stays refused.

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

  -- D178: no check of past products here. A photograph that is in no product now is the
  -- operator's to delete; Shopify keeps its own copy of any picture it was sent.

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
  'Atomically removes an enhanced ungrouped photograph from the grouping race before external cleanup. Refuses current draft members. A photograph that once belonged to a product sent to Shopify and is in no product now may be deleted (D178).';

revoke all on function public.prepare_console_photo_delete(uuid, text)
  from public, anon, authenticated;
grant execute on function public.prepare_console_photo_delete(uuid, text)
  to service_role;
