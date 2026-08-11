-- New revision of the hand-chain image prompt: anchored fit, and a worn source
-- is kept. Inserted non-current. Nothing is promoted.
--
-- WHY
--
-- Reported 2026-08-10 against the live hand-chain batch (the preset WAS live —
-- both halves promoted). All three enhancements share one failure family, and
-- the worst case had the best possible source:
--
--   * `da012474` (IMG20260810175603) — photographed ALREADY WORN on a real
--     hand. The output moved the wrist section up the forearm, dropped one of
--     the two wrist-to-heart branches, and lost the finger loops — the chain
--     wraps around the edge of the palm instead of encircling a finger.
--   * `e10ec3ca` (IMG20260810174151) — the "wrist" section lies across the
--     knuckles with the clasp displayed on top of the hand.
--   * `9294e886` (IMG20260810174851) — the tassel drop lies flat along the
--     back of the hand as if glued down instead of hanging.
--
-- Two causes, both in the prompt:
--
--   1. SOURCE POSE IS NOT THE PRODUCT was unconditional — its very revision
--      name says "source pose ignored". Right for a piece dumped on a card;
--      wrong for a piece photographed worn, where the arrangement IS the
--      product evidence. The necklace preset already learned this ("IF THE
--      SOURCE IS ALREADY HANGING — KEEP that arrangement"); the hand-chain
--      prompt had no equivalent, so the operator's worn reference was
--      deliberately discarded and the model re-derived the fit from prose.
--   2. "Fit the real wrist section at the wrist" states a location, not a
--      fastening. Nothing said chains must ENCIRCLE — wrap around and
--      disappear behind — so the model satisfied the instruction by laying
--      chain on top of skin: a wrist band on the forearm, a clasp on the back
--      of the hand, a tassel glued flat.
--
-- WHAT CHANGES
--
-- Only the fit machinery. SOURCE AUTHORITY, FORM AND SCALE LOCK, ART
-- DIRECTION, SCENE, LIGHTING, COMMERCIAL RETOUCHING and OUTPUT are byte for
-- byte from the accepted revision:
--
--   * SOURCE POSE is scoped to loose sources and hands worn ones to a new
--     WORN SOURCE block: keep the attachment points, replace the hand, change
--     only scene and polish;
--   * WEARING AND FIT becomes four anchor rules: the wrist section ENCIRCLES
--     the wrist at the wrist crease; each crossing branch is routed
--     one-for-one; each finger loop ENCIRCLES the base of its finger; a
--     free-hanging element hangs under gravity, never flat along the skin;
--   * CAMERA AND CROP fixes one canonical hand pose (back of hand to camera,
--     wrist from an upper corner, fingers toward the opposite lower corner)
--     and keeps the wrist crease and every fitted finger base in frame;
--   * FINAL IDENTITY CHECK verifies the anchors, not just the counts.
--
-- The describer half is untouched: its connection ledgers on all three
-- failures were accurate. The fit was lost in the image stage, not the record.

do $migration$
declare
  v_actor constant text := 'migration:20260810130000';
  v_previous_id uuid;

  v_image constant text := $image$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference, into the exact same hand chain worn naturally on one hand. Photograph the real jewellery at its most flattering; improve only its presentation and fit, never its design.

PRIORITY ORDER — first preserve product identity, then fasten it truthfully to the hand, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: wrist section; branch and junction count; open or closed topology; strand count; chain-link construction and gauge; finger-loop and ring count; exact charm, motif and stone count, order, side placement and relative spacing; shapes, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

FORM AND SCALE LOCK — retain the product's real construction. A stylist may drape only genuinely flexible chain; rigid settings, motifs, rings and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the whole photographed scene; never enlarge a component independently. Do not reroute, stretch, merge or split any chain.

SOURCE POSE — when Image 1 shows the piece lying loose on a surface, card or fabric, that arrangement is an accident of the snapshot, not a fact about the product: re-pose it properly for retail and never reproduce the arrangement it was dumped in. When Image 1 shows the piece already worn on a hand, the opposite applies — see WORN SOURCE.

WORN SOURCE — KEEP A FIT THAT IS ALREADY CORRECT. When Image 1 shows this piece fitted on a real hand, that fit is product evidence: keep the same attachment points — the same wrist placement, the same number of branches routed over the back of the hand, the same finger carrying each loop or ring, every junction where the source puts it. Replace the hand itself with the retail hand described below, tidy the drape, and change only the scene, lighting, cleanliness and sharpness. Do not re-route a chain, move the wrist section, change which finger wears a loop, or drop or merge a branch that the worn source shows. Re-posing a fit that is already correct is how branches disappear.

WEARING AND FIT — a hand chain is FASTENED AT BOTH ENDS, not draped: it lies in gentle connected runs between real anchor points, and no part of it floats or lies loose unless the source shows a genuinely free-hanging element.
- THE WRIST SECTION ENCIRCLES THE WRIST at the wrist crease. Its chain visibly wraps around the wrist and disappears behind both sides, with the clasp, extender and tag riding at the side or underside. It never lies open across the top of the forearm, never sits high up the arm, and never crosses the knuckles.
- EACH CROSSING CHAIN lies along the back of the hand, following the hand's real contour under its own light weight. Route exactly the source's number of branches — never merge two branches into one, never split one into two, and never leave a branch out.
- EACH FINGER LOOP OR RING ENCIRCLES THE BASE OF ITS FINGER, visibly wrapping around it and disappearing behind, on the finger the construction implies — the middle finger unless the source shows another. A finger loop is never an open chain that slides off the edge of the hand.
- A FREE-HANGING ELEMENT — tassel, drop or dangling charm — hangs under gravity, falling clear of the hand where the pose allows. It never lies flat along the skin as if glued down.
Use a natural relaxed pose with softly settled fingers that reveals every junction without pulling the product taut. No floating, no invented routing, no loose ends the source does not have.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product on a real hand. Create one confident composition with a clear focal hierarchy and enough contrast that fine gold chain never disappears against skin. It must read immediately as a desirable storefront hero at mobile size, not as a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens. Frame a close three-quarter-above view of one relaxed adult hand, the back of the hand toward the camera, fingers together and gently curved, lying diagonally across the frame with the wrist entering from an upper corner and the fingertips reaching toward the opposite lower corner — the same hand pose every time. The wrist crease, the complete wrist section, every crossing chain and the base of every fitted finger stay in frame. Focus-stack the complete jewellery design so links, junctions, settings and decorative elements are crisp. Never crop a junction, clasp, extender, end cap, terminal tag or distinctive fitting.

SCENE AND BACKGROUND — one relaxed adult hand and forearm against soft pale pearl-ivory satin with a warm-neutral cream character, never a yellow or champagne colour cast. Keep the field behind the hand quiet and softly out of focus so it reads as luxurious texture rather than pattern. Natural skin texture with neat natural nails, no nail art, no rings or unrelated jewellery, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add soft, diffused contact shadows where the jewellery rests on skin so it feels physically worn.

COMMERCIAL RETOUCHING — remove the display card, packaging, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. Skin stays photorealistic with natural texture and even tone; the jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the wrist-section, branch, junction, strand, finger-loop, component and hardware counts, the chain construction, every connection and mounting type, asymmetry and relative scale against Image 1, and confirm the hand shows five natural fingers with correct anatomy. Confirm as well that the wrist section actually encircles the wrist at the wrist crease, that every loop encircles the base of its finger, that the branch count over the back of the hand matches Image 1 exactly, and that any tassel or drop hangs free rather than lying along the skin. Correct the presentation rather than changing any of those facts.

OUTPUT — one opaque, photorealistic square premium retail image showing exactly one hand. No second hand, face, mannequin, props, boxes, stands, flowers, text, watermarks, borders, halos, extra or missing fingers, warped anatomy, malformed metal or duplicated components.$image$;
begin
  -- The worn half must exist, or this is replacing something else.
  select p.id into v_previous_id
    from public.prompts as p
   where p.kind = 'image' and p.preset_slug = 'hand-chain'
   order by p.created_at desc, p.id desc
   limit 1;
  if v_previous_id is null then
    raise exception 'the hand-chain image preset is missing';
  end if;

  -- Self-staging: the audited composition classes stage a piece lying on a
  -- surface, which is the opposite of a worn fit.
  perform public.validate_prompt_body('image', v_image, false);

  if position('WORN SOURCE' in v_image) = 0
     or position('ENCIRCLES THE WRIST' in v_image) = 0
     or position('ENCIRCLES THE BASE OF ITS FINGER' in v_image) = 0
     or position('hangs under gravity' in v_image) = 0
     -- The invariants every preset in the suite is held to.
     or position('SOURCE AUTHORITY' in v_image) = 0
     or position('sole visual authority' in v_image) = 0
     or position('PRIORITY ORDER' in v_image) = 0
     or position('luxury e-commerce hero' in v_image) = 0
     or position('warm luxury studio lighting' in v_image) = 0
     or position('FINAL IDENTITY CHECK' in v_image) = 0
     or position('uniformly scaling' in v_image) = 0 then
    raise exception 'the anchored-fit hand-chain prompt is missing a required block';
  end if;

  -- The old prompt discarded every source pose unconditionally. If either of
  -- these survived a careless edit, the model would receive both instructions.
  if position('SOURCE POSE IS NOT THE PRODUCT' in v_image) > 0
     or position('route the exact source number of chains across the back of the hand' in v_image) > 0 then
    raise exception 'the anchored-fit prompt still carries an unconditional re-pose instruction';
  end if;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at, uses_composition, preset_slug, created_by
  )
  values (
    'image', 'Hand chain worn — anchored fit, keeps a worn source', v_image,
    'openai/gpt-image-2', false, now(), false, 'hand-chain', v_actor
  );

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.preset_revised',
    jsonb_build_object(
      'preset', 'hand-chain',
      'kind', 'image',
      'reason', 'worn references were discarded and chains were laid on top of skin instead of fastened around wrist and fingers',
      'evidence', jsonb_build_array(
        'da012474: worn source; wrist section moved up the forearm, one wrist-to-heart branch dropped, finger loops lost',
        'e10ec3ca: wrist section laid across the knuckles with the clasp on top of the hand',
        '9294e886: tassel drop lying flat along the back of the hand'
      ),
      'self_staging', true,
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
