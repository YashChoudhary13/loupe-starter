-- Model selection copies the current immutable prompt into a new live row. The
-- original D51 function predates style presets and copied only name/body/kind,
-- so changing a model silently erased preset_slug. For hand-chain and bag it
-- also reset uses_composition to TRUE, contradicting bodies that deliberately
-- have no composition token and breaking every later enhancement.

create or replace function public.select_prompt_model(
  p_kind public.prompt_kind,
  p_model text,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  current_prompt public.prompts%rowtype;
  next_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'select_prompt_model: actor is required'
      using errcode = '22023';
  end if;

  select *
    into current_prompt
    from public.prompts
   where kind = p_kind
     and is_default
     and archived_at is null
   for update;

  if not found then
    raise exception 'select_prompt_model: no live % prompt', p_kind
      using errcode = '55000',
            hint = 'Restore exactly one current prompt before changing its model.';
  end if;

  if current_prompt.model = p_model then
    return current_prompt.id;
  end if;

  if exists (
    select 1
      from public.intake_files
     where status = 'enhancing'
       and lease_expires_at > now()
  ) then
    raise exception 'select_prompt_model: enhancement work is currently in flight'
      using errcode = '55000',
            hint = 'Wait for the current enhancement to finish, then choose the model again.';
  end if;

  update public.prompts
     set is_default = false,
         archived_at = now()
   where id = current_prompt.id;

  insert into public.prompts (
    name,
    body,
    kind,
    model,
    is_default,
    uses_composition,
    preset_slug,
    created_by
  )
  values (
    current_prompt.name,
    current_prompt.body,
    current_prompt.kind,
    p_model,
    true,
    current_prompt.uses_composition,
    current_prompt.preset_slug,
    btrim(p_actor)
  )
  returning id into next_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    next_id,
    'prompt.model_selected',
    jsonb_build_object(
      'kind', p_kind,
      'previous_prompt_id', current_prompt.id,
      'previous_model', current_prompt.model,
      'model', p_model,
      'preset_slug', current_prompt.preset_slug,
      'uses_composition', current_prompt.uses_composition
    ),
    btrim(p_actor)
  );

  return next_id;
end;
$$;

comment on function public.select_prompt_model(public.prompt_kind, text, text) is
  'Atomically selects a curated model by copying the current immutable prompt, including its preset identity and derived composition behavior.';

revoke all on function public.select_prompt_model(public.prompt_kind, text, text)
  from public, anon, authenticated;
grant execute on function public.select_prompt_model(public.prompt_kind, text, text)
  to service_role;

-- D66 tagged the accepted catalogue pair as the satin preset. The production
-- carry-over then selected new models through the old function and lost both
-- tags. Restore them only when the live image body uniquely matches one preset
-- and the live describer matches that same preset's describe half.
do $$
declare
  v_slug text;
  v_matches integer;
begin
  select min(candidate.preset_slug), count(distinct candidate.preset_slug)::integer
    into v_slug, v_matches
    from public.prompts candidate
    join public.prompts live
      on live.kind = 'image'
     and live.is_default
     and live.archived_at is null
     and live.body = candidate.body
   where candidate.kind = 'image'
     and candidate.preset_slug is not null;

  if v_matches = 1 and exists (
    select 1
      from public.prompts live
      join public.prompts candidate
        on candidate.kind = 'describe'
       and candidate.preset_slug = v_slug
       and candidate.body = live.body
     where live.kind = 'describe'
       and live.is_default
       and live.archived_at is null
  ) then
    update public.prompts
       set preset_slug = v_slug
     where is_default
       and archived_at is null
       and kind in ('describe', 'image')
       and preset_slug is null;

    insert into public.events (entity_type, event, detail, actor)
    values (
      'prompt',
      'prompt.preset_identity_restored',
      jsonb_build_object('preset_slug', v_slug, 'reason', 'model-selection-copy-loss'),
      'migration:20260804160000'
    );
  end if;
end;
$$;
