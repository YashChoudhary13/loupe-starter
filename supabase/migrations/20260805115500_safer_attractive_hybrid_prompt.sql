-- Restore the selling power of the originally accepted luxury catalogue prompt
-- without restoring its freedom to redesign the product.  The prompt keeps the
-- exact identity, topology and uniform-scale contracts added on 2026-08-04,
-- adopts the original macro/light/retouching language that produced attractive
-- images, and delegates open/closed arrangement to the audited presentation
-- class rather than making one universal necklace assumption.

do $migration$
declare
  v_actor constant text := 'migration:20260805115500';
  v_image_base constant text := $image$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real jewellery at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then choose a truthful pose, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: open or closed topology, branches and connection points; strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A stylist may bend and drape only genuinely flexible chain; rigid settings, pendants, motifs, bands and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every pendant, charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, pendant or decorative run independently. Keep every component naturally aligned with its real attachment.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that fine gold chain does not disappear. It must read immediately as a desirable storefront hero at mobile size, not as a flat inventory record, technical diagram or stretched display of length.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens. Choose the angle from the real construction: near-overhead for flat flexible jewellery, optionally with a restrained 5-15 degree rake to reveal genuine relief; use a more dimensional three-quarter view only when the source visibly supports it. Focus-stack the complete jewellery design so links, connections, settings and decorative elements are crisp. Fill roughly 82-92% of the useful square with the deliberately posed silhouette. Arrange flexible length compactly so the focal design is large; plain repetitive chain may approach or pass an edge only when necessary, but never crop a pendant, decorative station, junction, clasp, extender, end cap or distinctive fitting.

PRODUCT-SPECIFIC POSE
{{COMPOSITION_DETAIL}}

SCENE AND BACKGROUND — <<BACKGROUND>>

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, open/closed topology, strand count, chain construction, component ledger and sequence, all connection and mounting types, hardware count, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, props, boxes, stands, flowers, text, watermarks, borders, halos, malformed metal or duplicated components.$image$;

  v_satin_background constant text := 'Use soft pale pearl-ivory satin with a warm-neutral cream character, never a yellow or champagne colour cast. Keep the centre beneath the jewellery quiet and nearly smooth; place one or two broad natural folds toward the outer edges, softly out of focus so they read as luxurious texture rather than pattern. No hard lines or objects touching, crossing or visually competing with the product.';
  v_marble_background constant text := 'Use a polished pale white-and-cream marble surface with sparse, soft warm-grey and very pale gold veining kept away from fine chain and decorative details. Let the far surface fall into gentle creamy optical softness. The stone is elegant supporting texture, never a competing pattern. No props, risers, hard horizon or objects touching the product.';
  v_yellow_background constant text := 'Use a seamless muted sand-yellow surface with a smooth quiet centre, no horizon and no visible pattern. Keep it softly warm but desaturated and sufficiently different from the metal for strong edge separation. Let tonal falloff create depth without changing the product colour. No props or objects touching the product.';

  v_satin_image text;
  v_marble_image text;
  v_yellow_image text;
  v_previous_image_id uuid;
  v_image_id uuid;
begin
  v_satin_image := replace(v_image_base, '<<BACKGROUND>>', v_satin_background);
  v_marble_image := replace(v_image_base, '<<BACKGROUND>>', v_marble_background);
  v_yellow_image := replace(v_image_base, '<<BACKGROUND>>', v_yellow_background);

  perform public.validate_prompt_body('image', v_satin_image, true);
  perform public.validate_prompt_body('image', v_marble_image, true);
  perform public.validate_prompt_body('image', v_yellow_image, true);

  if position('PRIORITY ORDER' in v_satin_image) = 0
     or position('SOURCE AUTHORITY — NON-NEGOTIABLE' in v_satin_image) = 0
     or position('FORM AND SCALE LOCK' in v_satin_image) = 0
     or position('85-100mm macro' in v_satin_image) = 0
     or position('82-92%' in v_satin_image) = 0
     or position('warm luxury studio lighting' in lower(v_satin_image)) = 0
     or position('uniformly scaling the entire photographed piece' in v_satin_image) = 0
     or position('FINAL IDENTITY CHECK' in v_satin_image) = 0 then
    raise exception 'hybrid prompt is missing a safety or art-direction invariant';
  end if;

  select p.id
    into v_previous_image_id
    from public.prompts as p
   where p.kind = 'image'
     and p.is_default
     and p.archived_at is null
   for update;

  if v_previous_image_id is null then
    raise exception 'hybrid prompt migration could not find the current image prompt';
  end if;

  update public.prompts
     set is_default = false,
         archived_at = coalesce(archived_at, now())
   where id = v_previous_image_id;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values (
    'image',
    'Pearl-ivory satin — protected luxury macro hero',
    v_satin_image,
    'openai/gpt-image-2',
    true,
    null,
    true,
    'satin',
    v_actor
  )
  returning id into v_image_id;

  -- Append refreshed saved jewellery presets.  The existing descriptor pairs,
  -- hand-chain preset and bag preset remain immutable and continue to be used.
  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values
    ('image', 'Marble — protected luxury macro hero', v_marble_image, 'openai/gpt-image-2', false, now(), true, 'marble', v_actor),
    ('image', 'Muted sand yellow — protected luxury macro hero', v_yellow_image, 'openai/gpt-image-2', false, now(), true, 'yellow', v_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    v_image_id,
    'prompt.default_replaced',
    jsonb_build_object(
      'kind', 'image',
      'model', 'openai/gpt-image-2',
      'previous_prompt_id', v_previous_image_id,
      'contract', 'protected-luxury-macro-hero',
      'inspired_by', 'original-accepted-luxury-catalogue-art-direction',
      'safety_layers', jsonb_build_array(
        'source-authority', 'topology', 'component-ledger',
        'exact-chain-geometry', 'uniform-whole-piece-zoom', 'final-identity-check'
      ),
      'photography_layers', jsonb_build_array(
        'macro-lens-character', 'adaptive-angle', '82-92-percent-framing',
        'warm-luxury-three-light-setup', 'controlled-stone-speculars',
        'commercial-retouching', 'creamy-optical-background'
      ),
      'presets_refreshed', jsonb_build_array('satin', 'marble', 'yellow')
    ),
    v_actor
  );
end
$migration$;
