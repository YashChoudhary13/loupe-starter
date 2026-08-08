-- Redo is broken whenever a self-staging preset is the live image prompt.
--
-- `enqueue_image_redo` validates the current prompt with a TWO-argument call:
--
--     perform public.validate_prompt_body(v_prompt.kind, v_prompt.body);
--
-- `p_uses_composition` therefore defaults to `true`, so the check demands a
-- {{COMPOSITION_DETAIL}} token from a prompt that must not have one, and every
-- redo fails with:
--
--     validate_prompt_body: image prompt needs exactly one {{COMPOSITION_DETAIL}} token
--
-- 20260801170000 added the third argument and updated `create_prompt_version`
-- and `promote_prompt_version` to pass it. `enqueue_image_redo` was missed, and
-- the gap stayed invisible because the live prompt had always been satin,
-- marble or yellow — all composed. It became real on 2026-08-08 the moment
-- `waist-chain` was promoted, and would have done the same for `necklace`,
-- `hand-chain` or `bag`.
--
-- The flag lives on the prompt row precisely so nothing has to infer it. Pass it.

create or replace function public.validate_current_image_prompt(p_prompt public.prompts)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  -- One place that knows a prompt validates against its OWN staging flag, so a
  -- future caller cannot reintroduce the two-argument mistake by copying.
  perform public.validate_prompt_body(
    p_prompt.kind,
    p_prompt.body,
    p_prompt.uses_composition
  );
end;
$$;

comment on function public.validate_current_image_prompt(public.prompts) is
  'Validates a prompt row against its own uses_composition flag. Use this rather than calling validate_prompt_body with two arguments, which silently assumes a composed prompt.';

do $migration$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid)
    into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enqueue_image_redo';

  if v_def is null then
    raise exception 'enqueue_image_redo is missing';
  end if;
  if position('validate_prompt_body(v_prompt.kind, v_prompt.body)' in v_def) = 0 then
    raise exception
      'enqueue_image_redo no longer contains the two-argument call this migration replaces — inspect it before re-running';
  end if;

  execute replace(
    v_def,
    'validate_prompt_body(v_prompt.kind, v_prompt.body)',
    'validate_current_image_prompt(v_prompt)'
  );
end;
$migration$;

do $verify$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid)
    into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enqueue_image_redo';

  if position('validate_current_image_prompt(v_prompt)' in v_def) = 0 then
    raise exception 'the redo fix did not land';
  end if;
end;
$verify$;

revoke all on function public.validate_current_image_prompt(public.prompts)
  from public, anon, authenticated;
grant execute on function public.validate_current_image_prompt(public.prompts) to service_role;

insert into public.events (entity_type, entity_id, event, detail, actor)
values (
  'system', null, 'prompt.redo_validation_fixed',
  jsonb_build_object(
    'reason', 'enqueue_image_redo assumed every image prompt is composed, so redo failed under any self-staging preset',
    'affected_presets', jsonb_build_array('necklace', 'waist-chain', 'hand-chain', 'bag'),
    'found_live_under', 'waist-chain'
  ),
  'migration:20260808150000'
);
