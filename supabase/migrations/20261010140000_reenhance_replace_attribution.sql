-- D145 fix: the first replacement ever sent (2026-10-10, six re-renders the owner asked for) was refused
-- with 23514 image_versions_generated_is_attributed. replace_intake_image_from_agent wrote a generated
-- version without cost_usd, description_injected and description_missing, which that check has required
-- since Phase 3b. Same function, those three columns filled in.

create or replace function public.replace_intake_image_from_agent(
  p_intake_file_id uuid, p_storage_key text, p_thumb_key text, p_width integer, p_height integer,
  p_phash text, p_actor text, p_tag text, p_note text, p_job_id uuid, p_sha256 text default null
)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_file    public.intake_files%rowtype;
  v_no      integer;
  v_version uuid;
begin
  if p_tag is not null and p_tag not in ('needs_review', 'ready', 'restock') then
    raise exception 'replace_intake_image_from_agent: tag must be needs_review, ready or restock' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_storage_key, '')), '') is null or nullif(btrim(coalesce(p_thumb_key, '')), '') is null then
    raise exception 'replace_intake_image_from_agent: storage and thumb keys are required' using errcode = '22023';
  end if;
  if p_width is null or p_width <= 0 or p_height is null or p_height <= 0 then
    raise exception 'replace_intake_image_from_agent: dimensions must be positive' using errcode = '22023';
  end if;
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'replace_intake_image_from_agent: no intake_file %', p_intake_file_id using errcode = 'P0002';
  end if;

  select coalesce(max(version_no), -1) + 1 into v_no from public.image_versions where intake_file_id = p_intake_file_id;
  update public.image_versions set is_selected = false where intake_file_id = p_intake_file_id and is_selected;
  -- image_versions_generated_is_attributed wants every generated row to say what it cost and whether a
  -- product description was injected or missing. Rendered outside Loupe: no cost here, no describer.
  insert into public.image_versions (intake_file_id, version_no, kind, storage_key, thumb_key, width, height, is_selected, prompt_text, model,
                                     cost_usd, description_injected, description_missing)
  values (p_intake_file_id, v_no, 'generated', btrim(p_storage_key), btrim(p_thumb_key), p_width, p_height, true,
          coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Re-enhanced by Claude'), 'claude-agent',
          0, false, false)
  returning id into v_version;
  -- Every draft that carried a version of this photograph now carries the new one, same position.
  update public.product_draft_images pdi
     set image_version_id = v_version
   where pdi.image_version_id in (select id from public.image_versions where intake_file_id = p_intake_file_id and id <> v_version);

  update public.intake_files
     set agent_tag = coalesce(p_tag, agent_tag),
         agent_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 500), ''), agent_note),
         agent_sha256 = coalesce(p_sha256, agent_sha256),
         phash = coalesce(p_phash, phash),
         reenhance_job_id = null, reenhance_note = null,
         last_error = case when last_error like 'Not enhanced%' then null else last_error end,
         last_error_code = case when last_error like 'Not enhanced%' then null else last_error_code end
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.agent_replaced',
          jsonb_strip_nulls(jsonb_build_object('version_no', v_no, 'version_id', v_version, 'job_id', p_job_id, 'tag', p_tag, 'note', nullif(btrim(coalesce(p_note, '')), ''))),
          btrim(p_actor));
  return jsonb_build_object('intake_id', p_intake_file_id, 'version_no', v_no);
end;
$$;

revoke all on function public.replace_intake_image_from_agent(uuid, text, text, integer, integer, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.replace_intake_image_from_agent(uuid, text, text, integer, integer, text, text, text, text, uuid, text) to service_role;
