-- The catalogue-matching satin prompt supersedes the marble Step 0 prompt.
-- Prompt history stays append-only: retire the old live default, then install
-- this exact body as the sole live default.

do $migration$
declare
  v_body constant text := $prompt$A single hero product photograph for an e-commerce jewellery catalogue.

Background — soft ivory-champagne satin with gentle natural folds, warm in tone. The fabric is softly out of focus so its folds read as texture, never as pattern. No props, no flowers, no vases, no risers, no boxes.

Lighting — warm and directional, like soft window light. Gentle shadow falloff across the fabric. Controlled specular highlights so the gold plating reads as polished metal rather than flat yellow. No hard shadows, no coloured light, no lens flare.

Composition — centre the product; it should occupy roughly 75-80% of the frame with even margins. Keep this framing identical for every product. Preserve the angle and orientation of the source photograph — do not reposition, rotate or restage the piece.

Focus — the product sharp front to back. The background softly defocused: a suggestion of depth, not a blur effect.

Fidelity — this outranks everything above. Reproduce the product exactly as photographed. Chain links, stone count, stone shape and facets, engraving, clasps, settings and plating colour must match the source precisely. Do not add sparkle, gemstones, or detail that is not present. Do not remove, straighten, lengthen or embellish any part of the product. Where a detail is unclear in the source, reproduce it as-is rather than inventing it.$prompt$;
  v_name constant text := 'Qimati ivory-champagne satin — catalogue fidelity';
  v_previous_prompt_id uuid;
  v_prompt_id uuid;
begin
  select id
    into v_previous_prompt_id
    from public.prompts
   where is_default
     and archived_at is null
   order by created_at desc
   limit 1;

  update public.prompts
     set is_default = false,
         archived_at = coalesce(archived_at, now())
   where is_default
     and archived_at is null
     and body <> v_body;

  select id
    into v_prompt_id
    from public.prompts
   where body = v_body
     and archived_at is null
   order by created_at desc
   limit 1;

  if v_prompt_id is null then
    insert into public.prompts (name, body, is_default, created_by)
    values (
      v_name,
      v_body,
      true,
      'business:2026-07-29'
    )
    returning id into v_prompt_id;
  else
    update public.prompts
       set name = v_name,
           is_default = true
     where id = v_prompt_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  select
    'prompt',
    v_prompt_id,
    'prompt.default_replaced',
    jsonb_build_object(
      'name', v_name,
      'previous_default_id', v_previous_prompt_id,
      'source', 'inspection of approximately 100 live catalogue images',
      'catalogue_background', 'ivory-champagne satin',
      'marble_rejected_for_catalogue_mismatch', true,
      'resolution_in_parameters', true,
      'sparkle_instruction_removed', true,
      'framing_and_fidelity_added', true
    ),
    'migration:20260729131000'
  where not exists (
    select 1
      from public.events
     where entity_type = 'prompt'
       and entity_id = v_prompt_id
       and event = 'prompt.default_replaced'
  );
end
$migration$;
