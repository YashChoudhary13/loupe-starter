-- Promoting a preset must pick up a NEWER revision of that preset.
--
-- `promote_prompt_preset` treated "a half is already live" as "nothing to do":
--
--     select id into v_current_id from prompts
--      where kind = v_half.kind and is_default and archived_at is null
--        and preset_slug is not distinct from v_slug;
--     if found then changed := false;          -- <— stops here
--
-- That is right when the live prompt IS the newest revision, and wrong the
-- moment a new revision of the SAME preset is added — which is exactly what
-- editing a preset means. Selecting `necklace` while `necklace` was already live
-- returned `changed: false` for both halves and left the old body running.
--
-- Observed twice on 2026-08-08. Two worn-V revisions sat in the table as `ready`
-- while the full-length prompt stayed live and kept producing the flat closed
-- oval it asks for, and the reasonable reading of that was "the new prompt does
-- not work" rather than "the new prompt was never switched on". A control that
-- silently does nothing is worse than one that errors.
--
-- The fix compares IDENTITY, not existence: promote unless the live prompt is
-- already the newest revision of that preset. Promotion still copies rather than
-- flipping in place, so the promoted copy becomes the newest revision and an
-- immediate second call is correctly a no-op.
--
-- Unchanged: both halves still move inside one transaction, the preset must
-- still define both halves, and a prompt change is still a deliberate operator
-- action rather than a side effect of deployment (D51).

create or replace function public.promote_prompt_preset(
  p_slug text,
  p_actor text
)
returns table (kind public.prompt_kind, prompt_id uuid, changed boolean)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_slug text := nullif(btrim(coalesce(p_slug, '')), '');
  v_half record;
  v_current_id uuid;
begin
  if v_slug is null then
    raise exception 'promote_prompt_preset: slug is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'promote_prompt_preset: actor is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.prompts
     where preset_slug = v_slug and kind = 'describe'
  ) then
    raise exception 'promote_prompt_preset: preset "%" has no describe prompt', v_slug
      using errcode = '22023',
            hint = 'A preset must define both the describer and the image prompt.';
  end if;
  if not exists (
    select 1 from public.prompts
     where preset_slug = v_slug and kind = 'image'
  ) then
    raise exception 'promote_prompt_preset: preset "%" has no image prompt', v_slug
      using errcode = '22023',
            hint = 'A preset must define both the describer and the image prompt.';
  end if;

  for v_half in
    -- The newest revision is the maintained template. Promotion copies it, so
    -- the copy is newer still and this same query then selects the copy.
    select distinct on (p.kind) p.kind, p.id
      from public.prompts as p
     where p.preset_slug = v_slug
     order by p.kind, p.created_at desc, p.id desc
  loop
    select p.id
      into v_current_id
      from public.prompts as p
     where p.kind = v_half.kind
       and p.is_default
       and p.archived_at is null;

    -- Identity, not existence. "A half of this preset is live" is not the same
    -- as "the newest revision of this preset is live", and conflating the two is
    -- what made editing a live preset impossible.
    if found and v_current_id = v_half.id then
      kind := v_half.kind;
      prompt_id := v_current_id;
      changed := false;
    else
      kind := v_half.kind;
      prompt_id := public.promote_prompt_version(v_half.id, p_actor);
      changed := true;
    end if;
    return next;
  end loop;
  return;
end;
$$;

comment on function public.promote_prompt_preset(text, text) is
  'Promotes both halves of the newest maintained revision of a style preset in one transaction. A half is left alone only when the live prompt IS that newest revision — selecting a preset that is already live still picks up a newer revision of it.';

revoke all on function public.promote_prompt_preset(text, text)
  from public, anon, authenticated;
grant execute on function public.promote_prompt_preset(text, text)
  to service_role;

insert into public.events (entity_type, entity_id, event, detail, actor)
values (
  'system', null, 'prompt.promotion_fixed',
  jsonb_build_object(
    'reason', 'selecting a preset that was already live silently left an older revision running',
    'observed', 'two worn-V necklace revisions sat ready while the full-length prompt stayed live'
  ),
  'migration:20260808180000'
);
