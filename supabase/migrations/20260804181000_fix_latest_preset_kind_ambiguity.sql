-- `kind` is also an OUT parameter of promote_prompt_preset(). Qualify the two
-- existence checks so PL/pgSQL never has to choose between that parameter and
-- prompts.kind. The reference-faithful defaults inserted by the prior migration
-- are unaffected; only preset switching was blocked.

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
    select 1 from public.prompts as p
     where p.preset_slug = v_slug and p.kind = 'describe'
  ) then
    raise exception 'promote_prompt_preset: preset "%" has no describe prompt', v_slug
      using errcode = '22023',
            hint = 'A preset must define both the describer and the image prompt.';
  end if;
  if not exists (
    select 1 from public.prompts as p
     where p.preset_slug = v_slug and p.kind = 'image'
  ) then
    raise exception 'promote_prompt_preset: preset "%" has no image prompt', v_slug
      using errcode = '22023',
            hint = 'A preset must define both the describer and the image prompt.';
  end if;

  for v_half in
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
       and p.archived_at is null
       and p.preset_slug is not distinct from v_slug;

    if found then
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
  'Promotes both halves of the newest maintained revision of a style preset in one transaction. A half already live is left alone.';

revoke all on function public.promote_prompt_preset(text, text)
  from public, anon, authenticated;
grant execute on function public.promote_prompt_preset(text, text)
  to service_role;
