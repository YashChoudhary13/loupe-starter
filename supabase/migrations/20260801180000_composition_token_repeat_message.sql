-- A body with the composition token TWICE reported the wrong reason.
--
-- create_prompt_version derives uses_composition as (count = 1), so two tokens
-- derived FALSE and the operator was told "self-staging image prompt must not
-- contain {{COMPOSITION_DETAIL}}" — while looking at a prompt that plainly does
-- use composition and has simply been pasted over. The rejection was right and
-- the sentence was misleading, which costs more time than the mistake did.
--
-- A repeat is now its own case, stated before either shape is considered.

create or replace function public.validate_prompt_body(
  p_kind public.prompt_kind,
  p_body text,
  p_uses_composition boolean default true
)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_description_token constant text := '{{PRODUCT_DESCRIPTION}}';
  v_composition_token constant text := '{{COMPOSITION_DETAIL}}';
  v_product_block constant text := E'PRODUCT\n{{PRODUCT_DESCRIPTION}}\n\n';
  v_description_count integer;
  v_composition_count integer;
  v_expected_count integer;
begin
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'validate_prompt_body: body is required'
      using errcode = '22023';
  end if;

  if p_kind <> 'image' then
    return;
  end if;

  v_description_count :=
    (length(p_body) - length(replace(p_body, v_description_token, '')))
    / length(v_description_token);
  v_composition_count :=
    (length(p_body) - length(replace(p_body, v_composition_token, '')))
    / length(v_composition_token);
  v_expected_count := case when coalesce(p_uses_composition, true) then 1 else 0 end;

  if v_description_count <> 1 or position(v_product_block in p_body) = 0 then
    raise exception 'validate_prompt_body: image prompt needs exactly one exact PRODUCT block'
      using errcode = '22023',
            hint = E'Include exactly: PRODUCT\\n{{PRODUCT_DESCRIPTION}} followed by one blank line.';
  end if;

  if v_composition_count > 1 then
    raise exception 'validate_prompt_body: image prompt repeats {{COMPOSITION_DETAIL}} % times',
      v_composition_count
      using errcode = '22023',
            hint = 'The composition token may appear once, or not at all if the prompt stages the product itself. Delete the duplicates.';
  end if;

  if v_composition_count <> v_expected_count then
    if v_expected_count = 1 then
      raise exception 'validate_prompt_body: image prompt needs exactly one {{COMPOSITION_DETAIL}} token'
        using errcode = '22023',
              hint = 'This prompt lets the describer choose the composition, so the token must appear exactly once.';
    else
      raise exception 'validate_prompt_body: self-staging image prompt must not contain {{COMPOSITION_DETAIL}}'
        using errcode = '22023',
              hint = 'This prompt stages the product itself, so remove the composition token — the describer''s classes all assume the piece is lying on a surface.';
    end if;
  end if;
end;
$$;
