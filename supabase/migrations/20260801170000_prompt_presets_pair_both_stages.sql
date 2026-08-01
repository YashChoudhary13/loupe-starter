-- A style preset is a PAIR of prompts, and the pair moves together.
--
-- Two defects, both reported from the live console:
--
-- 1. Promoting a self-staging preset failed with "Add or remove the composition
--    token so it appears once." validate_prompt_body() predates uses_composition
--    and demanded exactly one {{COMPOSITION_DETAIL}} token from EVERY image
--    prompt, so the hand-chain and bag presets — which deliberately carry none —
--    could be saved but never promoted.
--
-- 2. Promoting the image half alone leaves the describer contradicting it. The
--    accepted describer is written for jewellery lying on a surface: it forbids
--    mentioning a hand, and its vocabulary is stones, clasps, bezels and prongs.
--    Injected into the hand-chain prompt it never says how the piece is worn, and
--    injected into the bag prompt it describes a bag as though it were a bracelet.
--
-- So every preset now has a describe half as well as an image half, joined by
-- preset_slug, and promote_prompt_preset() promotes both inside one transaction.
-- Half a preset is never a reachable state.
--
-- The marble and yellow describe halves are byte-identical to the accepted live
-- describer — those presets only change the background, and a described piece
-- must not change because the surface under it did.

-- ---------------------------------------------------------------------------
-- 1. Validation learns about self-staging prompts
-- ---------------------------------------------------------------------------
-- The flag is no longer independent of the body: create_prompt_version derives
-- it from the token count below, so the two can never disagree by accident. The
-- argument still exists because promotion validates a row that was written
-- before this migration, or by hand.

drop function public.validate_prompt_body(public.prompt_kind, text);

create function public.validate_prompt_body(
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

comment on function public.validate_prompt_body(public.prompt_kind, text, boolean) is
  'Shared activation guard. An image prompt needs exactly one PRODUCT block, and exactly one composition token when it uses the describer''s composition — or none at all when it stages the product itself.';

-- ---------------------------------------------------------------------------
-- 2. Creating a version derives uses_composition from the body
-- ---------------------------------------------------------------------------
-- Deriving rather than asking removes a whole failure mode: an operator who
-- edits a preset body cannot leave the flag pointing at the old shape, and the
-- console needs no extra control that could be set wrongly. Zero tokens means
-- self-staging, one means describer-composed, and anything else is refused.

drop function public.create_prompt_version(public.prompt_kind, text, text, text, text);

create function public.create_prompt_version(
  p_kind public.prompt_kind,
  p_name text,
  p_body text,
  p_model text,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_composition_token constant text := '{{COMPOSITION_DETAIL}}';
  v_uses_composition boolean := true;
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'create_prompt_version: actor is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'create_prompt_version: name is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_name)) > 160 then
    raise exception 'create_prompt_version: name is longer than 160 characters'
      using errcode = '22023';
  end if;
  if length(p_body) > 20000 then
    raise exception 'create_prompt_version: body is longer than 20000 characters'
      using errcode = '22023';
  end if;

  if p_kind = 'image' then
    v_uses_composition :=
      (length(p_body) - length(replace(p_body, v_composition_token, '')))
      / length(v_composition_token) = 1;
  end if;

  perform public.validate_prompt_body(p_kind, p_body, v_uses_composition);

  insert into public.prompts (
    name,
    body,
    kind,
    model,
    is_default,
    uses_composition,
    created_by
  )
  values (
    btrim(p_name),
    p_body,
    p_kind,
    btrim(p_model),
    false,
    v_uses_composition,
    btrim(p_actor)
  )
  returning id into v_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    v_id,
    'prompt.version_created',
    jsonb_build_object(
      'kind', p_kind,
      'model', btrim(p_model),
      'uses_composition', v_uses_composition,
      'made_current', false
    ),
    btrim(p_actor)
  );

  return v_id;
end;
$$;

comment on function public.create_prompt_version(public.prompt_kind, text, text, text, text) is
  'Creates a non-current immutable prompt version. The live default is untouched. uses_composition is derived from the body, so the flag can never contradict the tokens.';

-- ---------------------------------------------------------------------------
-- 3. Promotion validates against the row's own shape and carries it forward
-- ---------------------------------------------------------------------------
-- The reactivation branch previously copied name, body, kind and model but not
-- uses_composition or preset_slug. Promoting an archived self-staging preset
-- therefore produced a live prompt flagged as describer-composed with no token
-- in it, and resolveImagePrompt() would have refused every enhancement from that
-- point on. Every preset ships archived, so this was on the only path that
-- matters.

create or replace function public.promote_prompt_version(
  p_prompt_id uuid,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_target public.prompts%rowtype;
  v_current public.prompts%rowtype;
  v_promoted_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'promote_prompt_version: actor is required'
      using errcode = '22023';
  end if;

  select *
    into v_target
    from public.prompts
   where id = p_prompt_id
   for update;

  if not found then
    raise exception 'promote_prompt_version: prompt % does not exist', p_prompt_id
      using errcode = '22023';
  end if;

  perform public.validate_prompt_body(
    v_target.kind,
    v_target.body,
    v_target.uses_composition
  );

  select *
    into v_current
    from public.prompts
   where kind = v_target.kind
     and is_default
     and archived_at is null
   for update;

  if not found then
    raise exception 'promote_prompt_version: no live % prompt', v_target.kind
      using errcode = '55000';
  end if;

  if v_current.id = v_target.id then
    return v_current.id;
  end if;

  if exists (
    select 1
      from public.intake_files
     where status = 'enhancing'
       and lease_expires_at > now()
  ) or exists (
    select 1
      from public.image_redo_jobs
     where status = 'processing'
       and lease_expires_at > now()
  ) then
    raise exception 'promote_prompt_version: enhancement work is currently in flight'
      using errcode = '55000',
            hint = 'Wait for the current enhancement or redo to finish, then promote again.';
  end if;

  update public.prompts
     set is_default = false,
         archived_at = now()
   where id = v_current.id;

  if v_target.archived_at is null then
    update public.prompts
       set is_default = true
     where id = v_target.id
    returning id into v_promoted_id;
  else
    -- Reactivating archived history creates a fresh current version rather than
    -- rewriting when that historical row was archived. It must carry the shape
    -- of what it copies: the staging flag and the preset it belongs to.
    insert into public.prompts (
      name, body, kind, model, is_default, uses_composition, preset_slug, created_by
    )
    values (
      v_target.name,
      v_target.body,
      v_target.kind,
      v_target.model,
      true,
      v_target.uses_composition,
      v_target.preset_slug,
      btrim(p_actor)
    )
    returning id into v_promoted_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    v_promoted_id,
    'prompt.promoted',
    jsonb_build_object(
      'kind', v_target.kind,
      'source_prompt_id', v_target.id,
      'previous_prompt_id', v_current.id,
      'model', v_target.model,
      'preset_slug', v_target.preset_slug,
      'uses_composition', v_target.uses_composition
    ),
    btrim(p_actor)
  );

  return v_promoted_id;
end;
$$;

comment on function public.promote_prompt_version(uuid, text) is
  'Atomically promotes one validated version and leaves exactly one live default for its kind. Archived history is copied — including its staging flag and preset — never rewritten.';

-- ---------------------------------------------------------------------------
-- 4. The describe half of every preset
-- ---------------------------------------------------------------------------
-- marble and yellow reuse the accepted live describer verbatim. hand-chain and
-- bag replace it, because that describer cannot say what those image prompts
-- need to be told.
--
-- All four keep the same strict JSON contract and the same six presentation
-- classes, because the worker validates the enum on every reply regardless of
-- which preset is live. For the self-staging presets the class is recorded and
-- then unused — their image prompts have no token to put it in.

insert into public.prompts (kind, name, body, model, is_default, archived_at, preset_slug)
select
  'describe'::public.prompt_kind,
  v.name,
  v.body,
  (select model from public.prompts
    where kind = 'describe' and is_default and archived_at is null limit 1),
  false,
  now(),
  v.slug
from (values
  (
    'Marble surface — describer',
    'marble',
    (select body from public.prompts
      where kind = 'describe' and is_default and archived_at is null limit 1)
  ),
  (
    'Plain yellow backdrop — describer',
    'yellow',
    (select body from public.prompts
      where kind = 'describe' and is_default and archived_at is null limit 1)
  ),
  (
    'Hand chain — worn — describer',
    'hand-chain',
'You are describing a piece of jewellery for a product catalogue.

Describe ONLY the jewellery in this photograph. The photo may show the piece on a retail
display card, held in a hand, inside packaging, or on a cluttered surface — ignore all of
that completely.

Cover, in this order: the item type; the metal colour and finish; the overall form and
silhouette; any stones — their type, cut, colour, and how they are set and arranged; the
chain or band construction; clasps, bezels, prongs or other fittings; and any texture,
engraving or distinguishing feature.

This piece is worn on the hand, so ALSO state plainly how it is put together: which
section encircles the wrist, how many connecting chains run from it and where they
attach, and which sections form finger loops or rings. Describe the way the parts join —
that is what the photograph has to reproduce on a hand.

Rules:
- 60 to 100 words. One paragraph. No bullet points, no headings.
- Plain factual description only. No adjectives about beauty, quality, luxury or value.
- Do NOT state exact counts of stones or links. Describe density and arrangement instead
  — "densely set pavé along the chain", not "twelve stones". Connecting chains and finger
  loops are the exception: state how many there are, because the shot depends on it.
- Do not describe the model, the skin, the hand pose, the background, packaging, lighting
  or photography. Describe the piece and how its parts connect, nothing else.
- If a detail is not clearly visible, omit it. Never guess or invent.
- Output the description only. No preamble, no explanation, no closing remark.

Then choose exactly ONE presentation class for this piece from this list:

  pair-upright            a matched pair (earrings, studs)
  flat-curve              necklaces and long chains
  standing-three-quarter  rings
  angled-band             kadas, bangles, cuffs, rigid bracelets
  flat-arc                chain bracelets, anklets, flexible bracelets
  tray-grid               a set, tray or card holding multiple separate items

This preset stages the piece on a hand, so the class does not compose the photograph.
Still return the closest one from the list.

Return ONLY a JSON object, nothing else:
{"description": "<the paragraph above>", "presentation": "<one class from the list>"}

Output raw JSON only. Do not wrap it in markdown, code fences, or triple backticks. The
response must start with { and end with } and contain nothing else.'
  ),
  (
    'Bags — standing — describer',
    'bag',
'You are describing a bag or pouch for a product catalogue.

Describe ONLY the product in this photograph. The photo may show it on a retail display,
held in a hand, inside packaging, or on a cluttered surface — ignore all of that
completely.

Cover, in this order: the item type; the overall shape and silhouette, and whether it
holds a structured form or is soft; the material and its surface — fabric weave, knit,
leather grain, mesh or beading — and its colour; the closure, whether zip, flap, magnet
or drawstring, and its pull or fastening; the handles or straps and how they attach; any
hardware, and its metal colour; and stitching, piping, panels or trim.

Then, if the product carries any printed or embroidered artwork or LETTERING, transcribe
the text EXACTLY — the same words, the same spelling, the same capitalisation — and say
where it sits and what colour it is. This is the one detail the photograph most often
gets wrong, so it must be recorded precisely or not at all.

Rules:
- 60 to 100 words. One paragraph. No bullet points, no headings.
- Plain factual description only. No adjectives about beauty, quality, luxury or value.
- Do not describe the background, packaging, price tags, hands, lighting or photography.
- If a detail is not clearly visible, omit it. Never guess or invent. If lettering cannot
  be read with certainty, do not transcribe it at all — a wrong word is worse than none.
- Output the description only. No preamble, no explanation, no closing remark.

Then choose exactly ONE presentation class from this list:

  pair-upright            a matched pair (earrings, studs)
  flat-curve              necklaces and long chains
  standing-three-quarter  rings
  angled-band             kadas, bangles, cuffs, rigid bracelets
  flat-arc                chain bracelets, anklets, flexible bracelets
  tray-grid               a set, tray or card holding multiple separate items

None of these describes a bag. This preset stands the bag up itself, so the class does not
compose the photograph — return standing-three-quarter and ignore its wording.

Return ONLY a JSON object, nothing else:
{"description": "<the paragraph above>", "presentation": "<one class from the list>"}

Output raw JSON only. Do not wrap it in markdown, code fences, or triple backticks. The
response must start with { and end with } and contain nothing else.'
  )
) as v(name, slug, body)
where not exists (
  select 1 from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = v.slug
);

-- ---------------------------------------------------------------------------
-- 5. Promote a preset — both halves, or neither
-- ---------------------------------------------------------------------------

create function public.promote_prompt_preset(
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

  -- Both halves must exist before either moves. A preset that changed only the
  -- background while the describer still spoke about a different product is the
  -- exact failure this function exists to prevent.
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
    -- The template is the OLDEST row for the slug: promoting an archived preset
    -- copies it, and the copy carries the slug too. Ordering by age keeps
    -- repeated promotions pointing at the same original text.
    select distinct on (p.kind) p.kind, p.id
      from public.prompts as p
     where p.preset_slug = v_slug
     order by p.kind, p.created_at asc
  loop
    select p.id
      into v_current_id
      from public.prompts as p
     where p.kind = v_half.kind
       and p.is_default
       and p.archived_at is null
       and p.preset_slug is not distinct from v_slug;

    if found then
      -- Already live. Re-promoting would archive it and insert an identical
      -- copy for no reason.
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
  'Promotes both halves of a style preset in one transaction. A half already live is left alone rather than re-copied.';

revoke all on function public.validate_prompt_body(public.prompt_kind, text, boolean)
  from public, anon, authenticated;
revoke all on function public.create_prompt_version(public.prompt_kind, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.promote_prompt_preset(text, text)
  from public, anon, authenticated;

grant execute on function public.validate_prompt_body(public.prompt_kind, text, boolean)
  to service_role;
grant execute on function public.create_prompt_version(public.prompt_kind, text, text, text, text)
  to service_role;
grant execute on function public.promote_prompt_preset(text, text)
  to service_role;
