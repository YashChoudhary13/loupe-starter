-- Balance product fidelity with persuasive retail photography.
--
-- The first GPT Image 2 prompt revision solved component invention, but it
-- over-corrected into a flat inventory record: every necklace shared one
-- flat-curve pose, the whole chain was forced into a small 65-75% frame, and
-- commercial polish was explicitly suppressed.  This revision keeps every
-- identity lock while giving the photographer room to choose a truthful hero
-- crop, accurate form, controlled lustre and product-specific necklace pose.

alter type public.presentation_class add value if not exists 'necklace-pendant';
alter type public.presentation_class add value if not exists 'necklace-station';
alter type public.presentation_class add value if not exists 'necklace-multistrand';
alter type public.presentation_class add value if not exists 'necklace-lariat';

-- A redo historically reused a permanently-missing descriptor.  That made a
-- later, better image model run with no identity record and the generic legacy
-- flat-curve fallback.  A user-requested redo may now recover that missing
-- record once from the immutable original before spending on the image call.
create or replace function public.store_redo_description(
  p_intake_file_id uuid,
  p_description text,
  p_presentation_class public.presentation_class,
  p_model text,
  p_cost_usd numeric,
  p_actor text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_words integer;
begin
  if p_intake_file_id is null then
    raise exception 'store_redo_description: intake file id is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null
     or position(E'\n' in p_description) > 0
     or position(E'\r' in p_description) > 0
  then
    raise exception 'store_redo_description: description must be one non-empty paragraph'
      using errcode = '22023';
  end if;
  v_words := cardinality(regexp_split_to_array(btrim(p_description), '\s+'));
  if v_words < 80 or v_words > 200 then
    raise exception 'store_redo_description: description must contain 80-200 words, got %', v_words
      using errcode = '22023';
  end if;
  if p_presentation_class is null then
    raise exception 'store_redo_description: presentation class is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_model, '')), '') is null then
    raise exception 'store_redo_description: model is required'
      using errcode = '22023';
  end if;
  if p_cost_usd is null or p_cost_usd < 0 then
    raise exception 'store_redo_description: cost must be non-negative'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'store_redo_description: actor is required'
      using errcode = '22023';
  end if;

  select f.*
    into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
   for update;

  if not found then
    raise exception 'store_redo_description: no intake file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.status not in ('enhanced', 'grouped') then
    raise exception 'store_redo_description: intake file % is %', p_intake_file_id, v_file.status
      using errcode = '55000',
            hint = 'Description recovery is available only while image redo is available.';
  end if;
  if v_file.product_description is not null then
    return false;
  end if;

  update public.intake_files as f
     set product_description           = btrim(p_description),
         presentation_class            = p_presentation_class,
         presentation_fallback         = false,
         presentation_fallback_reason  = null,
         description_model             = btrim(p_model),
         described_at                  = now(),
         description_cost_usd          = p_cost_usd,
         description_error             = null,
         description_error_code        = null,
         description_error_detail      = null,
         description_missing_at        = null
   where f.id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'description.recovered_for_redo',
    jsonb_build_object(
      'model', btrim(p_model),
      'cost_usd', p_cost_usd,
      'word_count', v_words,
      'presentation_class', p_presentation_class,
      'replaced_missing_fallback', v_file.description_missing_at is not null
        or v_file.presentation_fallback
    ),
    btrim(p_actor)
  );

  return true;
end;
$$;

comment on function public.store_redo_description(
  uuid, text, public.presentation_class, text, numeric, text
) is
  'Write-once recovery of a missing structured identity record before a user-requested image redo. It replaces a legacy missing/flat-curve fallback but never overwrites a valid cached description.';

revoke all on function public.store_redo_description(
  uuid, text, public.presentation_class, text, numeric, text
) from public, anon, authenticated;
grant execute on function public.store_redo_description(
  uuid, text, public.presentation_class, text, numeric, text
) to service_role;

do $migration$
declare
  v_actor constant text := 'migration:20260804193000';
  v_jewellery_describer text;
  v_hand_chain_describer text;
  v_bag_describer text;

  v_jewellery_image_base constant text := $image$Create one square premium retail hero photograph by editing Image 1, the supplied product reference. The result must make the real jewellery desirable through professional photography, posing and retouching, never through product redesign.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SCENE AND BACKGROUND — <<BACKGROUND>>

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT IDENTITY is a factual inspection aid. First inspect Image 1 closely. Preserve the exact same physical product, including item count, topology, connection points, strand count, chain-link style and gauge, component count and order, side placement, relative spacing, settings and mounting methods, motif and pendant geometry, clasp, extender, terminal tags, finish type, colour, proportions and asymmetry. If text and image conflict, follow the visible source.

FORM AND SCALE LOCK — preserve the product's true construction and believable resting form. Flexible chain may be gently arranged by a professional stylist; rigid parts may not be bent, stretched, compressed, widened, narrowed, flattened or reshaped. Keep pendants, charms, motifs and stones at their exact relative sizes. Any zoom is one uniform optical or camera crop applied to the photographed piece: never enlarge a stone, pendant or decorative section independently. Keep components naturally aligned with their real attachment; do not force a dangling part into an impossible face-on orientation or twist the chain to show it.

PROFESSIONAL COMPOSITION — make a persuasive storefront hero, not an inventory record or length diagram. Choose the angle, pose and crop around the product's actual construction and focal design. Use a low-distortion near-overhead product-photography view for flat flexible jewellery, with only a gentle rake when it reveals real relief without changing apparent proportions. Avoid wide-angle perspective. Fill the square confidently, normally about 82-92% by the posed product's bounding box, with controlled breathing room. Prefer the complete piece, but do not make the focal design tiny merely to show every centimetre of plain repetitive chain: plain chain may approach or continue just beyond a frame edge when a tighter crop is required. Never crop a pendant, decorative station, distinctive fitting or connection. Keep the focal decorated region prominent and legible at mobile storefront size.

PRODUCT-SPECIFIC POSE
{{COMPOSITION_DETAIL}}

COMMERCIAL RETOUCHING — remove the original display card, packaging, price labels, stickers, hands, clips and unrelated branding. Remove dust, lint, fingerprints and dull colour contamination. Present clean, accurate metal lustre with crisp edge definition, dimensional highlights and realistic dark reflections that separate the form. Preserve the source finish: do not turn brushed, engraved, antiqued or textured metal into featureless mirror metal. Existing stones and facets may show clean realistic brilliance, internal colour and small controlled specular highlights caused by the studio lights; do not add stones, glitter, starbursts or fake sparkles.

LIGHTING AND FOCUS — use a professional jewellery setup: a large soft directional key, gentle opposite fill and a restrained edge highlight, with accurate neutral colour and a soft believable contact shadow. Maintain clear highlight-to-shadow separation so gold does not disappear into the background. No washed-out exposure, muddy low contrast, saturated yellow cast, clipped metal highlights, bloom or harsh black shadows. Focus-stack the product so every decorative component and connection is crisp; background texture can soften away from it.

FORBIDDEN PRODUCT CHANGES — no extra, missing, duplicated, mirrored, redistributed or selectively enlarged component. Never convert a drilled, dangling or jump-ring-mounted charm into a prong- or bezel-set stone, or a solid-metal motif into a gemstone. Do not alter stone cuts or colours, simplify relief, thicken or replace chain, change spacing, add a clasp or extender, make asymmetry symmetrical, invent hidden detail or upgrade the design into a more expensive object.

OUTPUT — one opaque, photorealistic square premium retail photograph. Clean natural edges, no halos and no CGI appearance. No people, skin, mannequins, boxes, stands, flowers, props, borders, watermarks or added text.$image$;

  v_satin_background constant text := 'Use a pale neutral pearl-ivory satin surface, not yellow or champagne. Keep the central product field quiet and nearly smooth; place only one or two broad sculpted folds around the outer edges, never crossing behind thin chain or small details. Subtle fabric texture, soft warm-grey shadows and enough tonal separation for gold. No props or objects touching the product.';
  v_marble_background constant text := 'Use a pale neutral white-and-cream marble surface with sparse, soft warm-grey veining restricted away from the focal jewellery. The product must have clear tonal separation and the stone must remain secondary. No yellow cast, props, risers, boxes, flowers or objects touching the product.';
  v_yellow_background constant text := 'Use an opaque seamless muted sand-yellow surface with a smooth central field, no horizon and no pattern. Keep the yellow desaturated and sufficiently different from the metal so the product has strong edge separation. No props or objects touching the product.';

  v_hand_chain_image constant text := $image$Create one square premium retail hero photograph by editing Image 1 into the exact same hand-chain jewellery worn naturally on one hand. Sell the real product through professional photography and fit, never through redesign.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SCENE — one relaxed adult hand and forearm against pale neutral pearl-ivory satin. The central field stays quiet, with at most two broad folds at the outer edges. Natural skin texture and neat natural nails; no rings or unrelated jewellery, props, text or watermarks.

SOURCE AUTHORITY — Image 1 is the sole visual authority. Preserve exact item, wrist-section, branch, junction, strand, finger-loop, charm, motif, stone, clasp, extender and terminal-tag counts; all connections and sequence; chain style and gauge; component colours, shapes, cuts, mountings, proportions and asymmetry. The PRODUCT IDENTITY is only an inspection aid; follow the visible source if they conflict.

FIT, FORM AND SCALE — fit the real wrist section at the wrist, route the exact source number of chains across the back of the hand and fit the exact source number of loops or rings to the correct number of fingers. Use a natural relaxed pose that reveals every junction without pulling the product taut. Do not reroute, stretch, merge or split chain. Any zoom is uniform camera magnification of the hand and product; never enlarge jewellery components independently. Use a close three-quarter-above crop with low perspective distortion, making the jewellery prominent while keeping the required wrist and fingers in frame.

RETOUCHING AND LIGHT — remove original packaging and supports. Use clean accurate metal lustre, dimensional highlights, realistic stone brilliance and soft contact shadows on skin. Preserve the real finish and relief. The entire product is crisp; anatomy and skin stay photorealistic. No added sparkle, yellow cast, mirror-plastic metal, extra or missing fingers, warped hand, blur, halos or CGI appearance.

FORBIDDEN — no extra, missing, duplicated, mirrored, redistributed or selectively enlarged component. Do not change connection points, add a loop, simplify relief, thicken chain, regularise spacing or invent hidden detail. Output one opaque square premium retail photograph only.$image$;

  v_bag_image constant text := $image$Create one square premium retail hero photograph by editing Image 1 into the exact same bag or pouch. Make the real product desirable through professional photography, shaping and retouching, never through redesign.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SCENE — a pale white-and-cream marble surface with sparse low-contrast warm-grey veining and a clean warm-neutral studio backdrop. Keep veining away from artwork and edges. No props, risers, boxes, flowers or objects touching the product.

SOURCE AUTHORITY — Image 1 is the sole visual authority. Preserve exact silhouette, structure and proportions; material texture, weave or grain; panel and pocket layout; closure count; handle and strap count and attachments; hardware; stitching, seams, piping, trim, artwork, lettering, colours and asymmetry. The PRODUCT IDENTITY is only an inspection aid; follow the visible source if they conflict.

FORM, ANGLE AND CROP — use the most flattering truthful angle supported by the visible construction: near-front for a flat pouch, or a gentle three-quarter view only when real depth is visible. Use a normal-to-long product-lens look without wide-angle distortion. Fill about 78-88% of the square with clean breathing room. Preserve natural form: a soft bag stays softly shaped, a structured bag stays structured. Do not inflate, stretch, taper, flatten or invent an unseen side. Any zoom is uniform camera magnification of the whole product.

RETOUCHING AND LIGHT — remove packaging, hands, price labels and unrelated branding. Use a large soft directional key, gentle fill, controlled material highlights and one believable contact shadow. Clean dust and colour contamination while preserving texture, seams, artwork and exact lettering. Strong clear separation from the background; no washed-out exposure, artificial gloss, saturated cast, warped text, halos or CGI appearance.

FORBIDDEN — do not add, remove, duplicate, mirror or relocate a pocket, panel, gusset, zip, pull, clasp, handle, strap, charm, seam, word or decoration. Do not increase structure, invent lining or hidden detail, redesign artwork, translate text or alter spelling. Output one opaque square premium retail photograph only.$image$;

  v_satin_image text;
  v_marble_image text;
  v_yellow_image text;
  v_describe_id uuid;
  v_image_id uuid;
  v_latest record;
begin
  select p.body into v_jewellery_describer
    from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'satin'
   order by p.created_at desc, p.id desc
   limit 1;
  select p.body into v_hand_chain_describer
    from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'hand-chain'
   order by p.created_at desc, p.id desc
   limit 1;
  select p.body into v_bag_describer
    from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'bag'
   order by p.created_at desc, p.id desc
   limit 1;

  if v_jewellery_describer is null or v_hand_chain_describer is null or v_bag_describer is null then
    raise exception 'balanced retail migration could not find all maintained descriptor presets';
  end if;

  v_jewellery_describer := replace(
    v_jewellery_describer,
    'pair-upright for a matched pair; flat-curve for a necklace or long chain; standing-three-quarter for a ring; angled-band for a kada, bangle, cuff or rigid bracelet; flat-arc for a flexible bracelet or anklet; tray-grid for multiple separate items on one tray or card.',
    'pair-upright for a matched pair; necklace-pendant for a necklace with one dominant pendant or central drop; necklace-station for a single-strand necklace with spaced fixed or dangling decorative stations and no dominant pendant; necklace-multistrand for two or more joined parallel strands; necklace-lariat for an open Y-shaped necklace with a junction and drop; flat-curve only for another flexible long chain that fits none of those four necklace classes; standing-three-quarter for a ring; angled-band for a kada, bangle, cuff or rigid bracelet; flat-arc for a flexible bracelet or anklet; tray-grid for multiple separate items on one tray or card.'
  );
  v_jewellery_describer := replace(
    v_jewellery_describer,
    '<pair-upright|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>',
    '<pair-upright|necklace-pendant|necklace-station|necklace-multistrand|necklace-lariat|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>'
  );
  v_hand_chain_describer := replace(
    v_hand_chain_describer,
    'pair-upright, flat-curve, standing-three-quarter, angled-band, flat-arc, tray-grid',
    'pair-upright, necklace-pendant, necklace-station, necklace-multistrand, necklace-lariat, flat-curve, standing-three-quarter, angled-band, flat-arc, tray-grid'
  );
  v_hand_chain_describer := replace(
    v_hand_chain_describer,
    '<pair-upright|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>',
    '<pair-upright|necklace-pendant|necklace-station|necklace-multistrand|necklace-lariat|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>'
  );

  if position('necklace-pendant' in v_jewellery_describer) = 0
     or position('necklace-lariat' in v_hand_chain_describer) = 0 then
    raise exception 'balanced retail descriptor class expansion failed';
  end if;

  v_satin_image := replace(v_jewellery_image_base, '<<BACKGROUND>>', v_satin_background);
  v_marble_image := replace(v_jewellery_image_base, '<<BACKGROUND>>', v_marble_background);
  v_yellow_image := replace(v_jewellery_image_base, '<<BACKGROUND>>', v_yellow_background);

  update public.prompts
     set is_default = false,
         archived_at = coalesce(archived_at, now())
   where is_default
     and archived_at is null
     and kind in ('describe', 'image');

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Jewellery inspector — exact identity and professional pose class', v_jewellery_describer, 'openai/gpt-5.6-sol', true, null, true, 'satin', v_actor),
    ('image', 'Pearl-ivory satin — faithful premium retail hero', v_satin_image, 'openai/gpt-image-2', true, null, true, 'satin', v_actor);

  select p.id into v_describe_id
    from public.prompts as p
   where p.kind = 'describe' and p.is_default and p.archived_at is null;
  select p.id into v_image_id
    from public.prompts as p
   where p.kind = 'image' and p.is_default and p.archived_at is null;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Marble jewellery inspector — exact identity and pose class', v_jewellery_describer, 'openai/gpt-5.6-sol', false, now(), true, 'marble', v_actor),
    ('image', 'Marble — faithful premium retail hero', v_marble_image, 'openai/gpt-image-2', false, now(), true, 'marble', v_actor),
    ('describe', 'Yellow jewellery inspector — exact identity and pose class', v_jewellery_describer, 'openai/gpt-5.6-sol', false, now(), true, 'yellow', v_actor),
    ('image', 'Muted sand yellow — faithful premium retail hero', v_yellow_image, 'openai/gpt-image-2', false, now(), true, 'yellow', v_actor),
    ('describe', 'Hand chain — exact connection inspector', v_hand_chain_describer, 'openai/gpt-5.6-sol', false, now(), true, 'hand-chain', v_actor),
    ('image', 'Hand chain worn — faithful premium retail hero', v_hand_chain_image, 'openai/gpt-image-2', false, now(), false, 'hand-chain', v_actor),
    ('describe', 'Bags — exact construction inspector', v_bag_describer, 'openai/gpt-5.6-sol', false, now(), true, 'bag', v_actor),
    ('image', 'Bags — faithful premium retail hero', v_bag_image, 'openai/gpt-image-2', false, now(), false, 'bag', v_actor);

  perform public.validate_prompt_body('image', v_satin_image, true);
  perform public.validate_prompt_body('image', v_marble_image, true);
  perform public.validate_prompt_body('image', v_yellow_image, true);
  perform public.validate_prompt_body('image', v_hand_chain_image, false);
  perform public.validate_prompt_body('image', v_bag_image, false);

  if position('FORM AND SCALE LOCK' in v_satin_image) = 0
     or position('82-92%' in v_satin_image) = 0
     or position('uniform optical' in lower(v_satin_image)) = 0
     or position('never enlarge a stone' in lower(v_satin_image)) = 0
     or position('not an inventory record' in lower(v_satin_image)) = 0
     or position('pale neutral pearl-ivory' in lower(v_satin_image)) = 0 then
    raise exception 'balanced premium-retail image invariant is missing';
  end if;

  for v_latest in
    select distinct on (p.preset_slug, p.kind)
           p.preset_slug, p.kind, p.model, p.body
      from public.prompts as p
     where p.preset_slug is not null
     order by p.preset_slug, p.kind, p.created_at desc, p.id desc
  loop
    if (v_latest.kind = 'describe' and v_latest.model <> 'openai/gpt-5.6-sol')
       or (v_latest.kind = 'image' and v_latest.model <> 'openai/gpt-image-2') then
      raise exception 'preset % has the wrong % model', v_latest.preset_slug, v_latest.kind;
    end if;
    if v_latest.kind = 'image'
       and (position('premium retail hero' in lower(v_latest.body)) = 0
         or position('uniform' in lower(v_latest.body)) = 0) then
      raise exception 'preset % still has flat or selective-scale art direction', v_latest.preset_slug;
    end if;
  end loop;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values
    (
      'prompt', v_describe_id, 'prompt.default_replaced',
      jsonb_build_object(
        'kind', 'describe',
        'model', 'openai/gpt-5.6-sol',
        'presentation_classes_added', jsonb_build_array(
          'necklace-pendant', 'necklace-station', 'necklace-multistrand', 'necklace-lariat'
        ),
        'missing_redo_descriptions_recoverable', true
      ),
      v_actor
    ),
    (
      'prompt', v_image_id, 'prompt.default_replaced',
      jsonb_build_object(
        'kind', 'image',
        'model', 'openai/gpt-image-2',
        'contract', 'faithful-premium-retail-hero',
        'zoom_rule', 'uniform-optical-or-camera-crop-only',
        'known_failures_locked', jsonb_build_array(
          'selective-component-enlargement', 'long-narrow-measuring-loop',
          'flat-low-contrast-lighting', 'background-dominance', 'form-deformation'
        ),
        'presets_revised', jsonb_build_array('satin', 'marble', 'yellow', 'hand-chain', 'bag')
      ),
      v_actor
    );
end
$migration$;
