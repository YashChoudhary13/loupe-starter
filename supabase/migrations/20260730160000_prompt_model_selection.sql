-- Loupe · Phase 5 — curated model selection
--
-- D51: a model choice is part of the immutable prompt version. Switching a
-- model copies the current body into a new row, archives the old default and
-- leaves every historical row untouched.

alter table public.prompts
  add column model text;

update public.prompts
   set model = case kind
     when 'describe' then 'openai/gpt-5.6-sol'
     when 'image' then 'openai/gpt-image-2'
   end;

alter table public.prompts
  alter column model set not null,
  add constraint prompts_model_is_curated check (
    (
      kind = 'describe'
      and model in (
        'qwen/qwen3.7-flash',
        'google/gemini-3.5-flash-lite',
        'openai/gpt-5.6-luna-pro',
        'openai/gpt-5.4-mini',
        'anthropic/claude-haiku-4.5',
        'google/gemini-3.6-flash',
        'google/gemini-3.1-pro-preview',
        'openai/gpt-5.4',
        'anthropic/claude-sonnet-4.6',
        'openai/gpt-5.6-sol'
      )
    )
    or
    (
      kind = 'image'
      and model in (
        'black-forest-labs/flux.2-klein-4b',
        'black-forest-labs/flux.2-pro',
        'recraft/recraft-v4.1-utility',
        'bytedance-seed/seedream-4.5',
        'openai/gpt-image-1-mini',
        'x-ai/grok-imagine-image-quality',
        'black-forest-labs/flux.2-max',
        'google/gemini-3.1-flash-image',
        'google/gemini-3-pro-image',
        'openai/gpt-image-2'
      )
    )
  );

comment on column public.prompts.model is
  'Provider-qualified OpenRouter model selected for this immutable prompt version (D51).';

create function public.select_prompt_model(
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

  -- Refuse a mid-flight switch. A crash-recovery object records the requested
  -- model, so changing it under a held lease should be an explicit retry later,
  -- never an accidental mismatch.
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

  insert into public.prompts (name, body, kind, model, is_default, created_by)
  values (
    current_prompt.name,
    current_prompt.body,
    current_prompt.kind,
    p_model,
    true,
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
      'model', p_model
    ),
    btrim(p_actor)
  );

  return next_id;
end;
$$;

comment on function public.select_prompt_model(public.prompt_kind, text, text) is
  'Atomically creates a new prompt version with a curated model and promotes it as the sole live default.';

revoke all on function public.select_prompt_model(public.prompt_kind, text, text)
  from public, anon, authenticated;
grant execute on function public.select_prompt_model(public.prompt_kind, text, text)
  to service_role;
