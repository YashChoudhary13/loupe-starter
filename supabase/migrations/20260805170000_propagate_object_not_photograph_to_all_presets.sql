-- Propagate the 20260805160000 fixes to every preset.
--
-- That migration fixed satin only. Promoting Pale marble, Muted sand, Hand
-- chain or Bags would have reproduced both original defects exactly:
--
--   * the describer reporting the photograph's accidental layout ("laid as a
--     loose loop", "along the top edge", "down the left side", "obscured by a
--     finger"), which is injected as the PRODUCT record and then overrides the
--     posing stage — the generated necklace came out as the lumpy rounded
--     rectangle the piece was dumped in, instead of a clean oval;
--   * mandatory exact counts, which made an uncertain describer state eleven
--     stations where there are ten. The image model resolved that conflict
--     differently on two consecutive runs, so a wrong count is a coin flip that
--     can invent a component.
--
-- Measured after the fix on the same necklace: count corrected to ten, zero
-- frame-geography phrases, ordering switched to "From the clasp end the
-- sequence runs", $0.015856 at minimal effort.
--
-- What this migration does NOT do: convert the other presets to the short
-- 227-word art-direction shape. That restructure is still an unproven A/B
-- candidate and exists for satin only. Propagating a proven fix and holding an
-- unproven one are different decisions.
--
-- Every version is inserted non-current. Nothing is promoted.

do $migration$
declare
  v_actor constant text := 'migration:20260805170000';

  -- Applies to any product photographed on whatever surface was to hand.
  v_pose_clause constant text :=
    'SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. Its accidental outline, the direction the piece happens to lie, and anything overlapping it are facts about that one snapshot, not about the product. Re-pose the piece properly for retail; never reproduce the arrangement it was dumped in.

';

  v_shared_rules constant text :=
    'Rules:
- Describe the object, not the photograph. Never state how the piece happens to be lying or what overall outline it forms in the frame — no "laid in a rough square", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "top edge", "down the left side", "upper right", "at the bottom centre". That arrangement is re-posed later, and reporting it corrupts the posing stage that reads this record.
- Order components by their sequence along the product itself, starting from a named fixed point such as the clasp end, and never by position in the frame.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or something is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it.';

  v_jewellery_describer text;
  v_hand_chain_describer text;
  v_bag_describer text;
  v_satin_long_image text;
  v_marble_image text;
  v_yellow_image text;
  v_hand_chain_image text;
  v_bag_image text;
  v_inserted integer := 0;
begin
  -- The fixed jewellery inspector. marble and yellow historically share satin's
  -- describer byte for byte, so they take it verbatim rather than a near-copy
  -- that would drift.
  select p.body into v_jewellery_describer
    from public.prompts as p
   where p.kind = 'describe' and p.name = 'Jewellery inspector — object not photograph'
   order by p.created_at desc, p.id desc limit 1;
  if v_jewellery_describer is null then
    raise exception 'the fixed jewellery describer from 20260805160000 is missing';
  end if;

  select p.body into v_hand_chain_describer from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'hand-chain'
   order by p.created_at desc, p.id desc limit 1;
  select p.body into v_bag_describer from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'bag'
   order by p.created_at desc, p.id desc limit 1;

  select p.body into v_satin_long_image from public.prompts as p
   where p.kind = 'image' and p.name = 'Pearl-ivory satin — protected luxury macro hero'
   order by p.created_at desc, p.id desc limit 1;
  select p.body into v_marble_image from public.prompts as p
   where p.kind = 'image' and p.preset_slug = 'marble'
   order by p.created_at desc, p.id desc limit 1;
  select p.body into v_yellow_image from public.prompts as p
   where p.kind = 'image' and p.preset_slug = 'yellow'
   order by p.created_at desc, p.id desc limit 1;
  select p.body into v_hand_chain_image from public.prompts as p
   where p.kind = 'image' and p.preset_slug = 'hand-chain'
   order by p.created_at desc, p.id desc limit 1;
  select p.body into v_bag_image from public.prompts as p
   where p.kind = 'image' and p.preset_slug = 'bag'
   order by p.created_at desc, p.id desc limit 1;

  if v_hand_chain_describer is null or v_bag_describer is null
     or v_satin_long_image is null or v_marble_image is null or v_yellow_image is null
     or v_hand_chain_image is null or v_bag_image is null then
    raise exception 'preset propagation could not read every current preset body';
  end if;

  -- Describers: replace the whole Rules: header with the shared rules, keeping
  -- each preset's own domain rules that follow it.
  v_hand_chain_describer := replace(v_hand_chain_describer, 'Rules:', v_shared_rules);
  v_bag_describer := replace(v_bag_describer, 'Rules:', v_shared_rules);

  -- Image prompts: insert the pose clause immediately before ART DIRECTION.
  v_satin_long_image := replace(v_satin_long_image, 'ART DIRECTION —', v_pose_clause || 'ART DIRECTION —');
  v_marble_image     := replace(v_marble_image,     'ART DIRECTION —', v_pose_clause || 'ART DIRECTION —');
  v_yellow_image     := replace(v_yellow_image,     'ART DIRECTION —', v_pose_clause || 'ART DIRECTION —');
  v_hand_chain_image := replace(v_hand_chain_image, 'ART DIRECTION —', v_pose_clause || 'ART DIRECTION —');
  v_bag_image        := replace(v_bag_image,        'ART DIRECTION —', v_pose_clause || 'ART DIRECTION —');

  -- Every substitution must have landed exactly once, or a preset silently
  -- ships without the fix — the failure this migration exists to prevent.
  if position('Describe the object, not the photograph' in v_hand_chain_describer) = 0
     or position('Describe the object, not the photograph' in v_bag_describer) = 0
     or position('SOURCE POSE IS NOT THE PRODUCT' in v_satin_long_image) = 0
     or position('SOURCE POSE IS NOT THE PRODUCT' in v_marble_image) = 0
     or position('SOURCE POSE IS NOT THE PRODUCT' in v_yellow_image) = 0
     or position('SOURCE POSE IS NOT THE PRODUCT' in v_hand_chain_image) = 0
     or position('SOURCE POSE IS NOT THE PRODUCT' in v_bag_image) = 0 then
    raise exception 'preset propagation failed to apply every clause';
  end if;

  -- Token contracts are unchanged: satin/marble/yellow compose, the two
  -- self-staging presets do not.
  perform public.validate_prompt_body('image', v_satin_long_image, true);
  perform public.validate_prompt_body('image', v_marble_image, true);
  perform public.validate_prompt_body('image', v_yellow_image, true);
  perform public.validate_prompt_body('image', v_hand_chain_image, false);
  perform public.validate_prompt_body('image', v_bag_image, false);

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at, uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Marble jewellery inspector — object not photograph', v_jewellery_describer,
     'moonshotai/kimi-k3', false, now(), true, 'marble', v_actor),
    ('image', 'Marble — protected hero, source pose ignored', v_marble_image,
     'openai/gpt-image-2', false, now(), true, 'marble', v_actor),

    ('describe', 'Yellow jewellery inspector — object not photograph', v_jewellery_describer,
     'moonshotai/kimi-k3', false, now(), true, 'yellow', v_actor),
    ('image', 'Muted sand yellow — protected hero, source pose ignored', v_yellow_image,
     'openai/gpt-image-2', false, now(), true, 'yellow', v_actor),

    ('describe', 'Hand chain — connection inspector, object not photograph', v_hand_chain_describer,
     'moonshotai/kimi-k3', false, now(), true, 'hand-chain', v_actor),
    ('image', 'Hand chain worn — protected hero, source pose ignored', v_hand_chain_image,
     'openai/gpt-image-2', false, now(), false, 'hand-chain', v_actor),

    ('describe', 'Bags — construction inspector, object not photograph', v_bag_describer,
     'moonshotai/kimi-k3', false, now(), true, 'bag', v_actor),
    ('image', 'Bags — protected hero, source pose ignored', v_bag_image,
     'openai/gpt-image-2', false, now(), false, 'bag', v_actor),

    -- satin keeps its long prompt as an option alongside the short A/B one.
    ('image', 'Pearl-ivory satin — protected hero, source pose ignored', v_satin_long_image,
     'openai/gpt-image-2', false, now(), true, 'satin', v_actor);

  get diagnostics v_inserted = row_count;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.preset_revised',
    jsonb_build_object(
      'presets', jsonb_build_array('satin', 'marble', 'yellow', 'hand-chain', 'bag'),
      'reason', 'propagate object-not-photograph and count-hedging fixes to every preset',
      'versions_created', v_inserted,
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
