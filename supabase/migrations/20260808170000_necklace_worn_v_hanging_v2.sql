-- The worn V, second attempt — proved on a real source before shipping.
--
-- 20260808160000 was never promoted, so the enhancement the owner rejected on
-- 2026-08-08 was still produced by the FULL-LENGTH prompt. Its two faults were
-- real all the same, and both are addressed here:
--
--   1. FLAT. The piece was laid on satin and shot from above. The V wording in
--      20260808160000 described the shape but never said the camera looks
--      HORIZONTALLY at something suspended in air, so "hanging" was readable as
--      a top-down arrangement in a V outline. It is now the first and loudest
--      block, and it names the wrong answers: flat-lay, top-down, chain resting
--      on satin, shadow cast on a surface it lies on.
--   2. TWO NECKLACES MERGED. The source held two separate pendants; the output
--      interleaved them into one tangled double loop. Nothing in any prompt had
--      ever addressed a multi-item necklace source. `HOW MANY NECKLACES` now
--      requires exactly the source count, side by side, never touching, with the
--      four arms of two pieces leaving the top edge at four separated points.
--
-- THE PROP IS BACK, AND SPECIFIED. D95 chose no props to keep ~300 products a
-- month looking like one shoot. The owner reopened it ("if needed use a prop"),
-- and the rejected source shows why it earns its place: a ceramic form standing
-- BEHIND the jewellery is what makes "hanging in front of something" legible at
-- all. The consistency worry is answered by naming exactly one prop and one
-- sweep rather than banning props — a fixed prop is as repeatable as none.
--
-- ALSO NEW: `IF THE SOURCE IS ALREADY HANGING`. The rejected source was a
-- supplier catalogue photograph that already had the exact composition wanted,
-- and the pipeline degraded it. A prompt that only knows how to re-pose will
-- re-pose a photograph that was already right.
--
-- EVIDENCE — this body is byte-identical to the one tested against the rejected
-- source (intake 36f179c8-fb5b-461c-88eb-91ccea7865ba, two tulip pendants),
-- openai/gpt-image-2 at 1280x1280 medium, $0.080502 in 50.8s. Output verified by
-- eye: two separate hanging Vs, four arms leaving the top edge at four separated
-- points, no chains touching or crossing, each pendant the lowest point of its
-- own V, ceramic form soft behind, no neck or bust. Artifacts in
-- .artifacts/worn-v/ (source.jpg, generated-flat.png, gen-v2.png, gen-v3.png).
--
-- Inserted non-current. `promote_prompt_preset` cannot activate it while
-- `necklace` is already the live preset (D95) — promote this VERSION in
-- /prompts.

do $migration$
declare
  v_actor constant text := 'migration:20260808170000';
  v_image constant text := $image$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real jewellery at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then hang the piece as described below, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

HANGING, NOT LYING DOWN — THIS IS THE MOST IMPORTANT INSTRUCTION IN THIS BRIEF. The necklace is suspended in mid-air and photographed from the front, at the height of the pendant, the way it looks on a wearer's chest. It is NOT laid on a surface and NOT seen from above. There is no fabric, table or floor under it. Do not produce a flat-lay, a top-down view, a chain resting on satin, or a shadow of the chain cast on a surface it is lying on. The camera looks horizontally at a piece hanging in front of a backdrop.

THE V — each necklace hangs as a narrow V. Both of its chain arms rise from the pendant, diverge upward and outward, and run OFF THE TOP EDGE of the frame, where they are cut off. The clasp, extender and terminal tag are outside the frame; they exist on the product but are not shown, and must never be invented lower down. The pendant or lowest station sits at the bottom point of the V, hanging straight down under gravity, in the lower half of the frame with clean space beneath it. The arms are close to straight — gravity pulls them taut — with only a gentle inward curve near the bottom. Nothing holds the piece up: no neck, bust, mannequin, model, stand, hook or hand appears anywhere.

V WIDTH FOLLOWS THE PIECE — read it from Image 1. A short necklace makes a wider, shallower V whose arms leave the top edge nearer the corners. A longer necklace makes a narrower, deeper V. Never a closed loop, never an oval, never a horizontal line, never a chain doubling back on itself.

HOW MANY NECKLACES — count the separate necklaces in Image 1 and render EXACTLY that many, as separate hanging pieces. If there is one, centre it. If there are two or more, hang them side by side across the frame, evenly spaced, each one a complete V of its own with its own pendant at its own lowest point. THEY MUST NOT TOUCH, CROSS, OVERLAP OR INTERLEAVE: keep clear background between neighbouring chains along their whole length, including where they leave the top edge — the four arms of two necklaces exit the top edge at four clearly separated points, never converging toward the same point, and the gap between the two inner arms is at least as wide as a pendant. Never merge two necklaces into one chain or one shared loop. Hang a shorter piece slightly higher than a longer one so their pendants sit at different heights, exactly as their real lengths dictate. Every piece is rendered at its true length relative to the others.

IF THE SOURCE IS ALREADY HANGING — when Image 1 already shows the piece or pieces suspended with the chains leaving the top of the frame, KEEP that arrangement, spacing and pendant height. Change only the scene, the lighting, the cleanliness and the sharpness. Do not re-pose a photograph that is already correct.

FORM AND SCALE LOCK — keep the chain fine. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-pendant ratio, so many small links run down each arm. Never thicken links, lengthen them, or use fewer of them to fill the frame. Every pendant, station, charm and stone keeps its exact size relative to the chain. Rigid settings, pendants, motifs and connectors keep their real shape. Zoom only by moving the camera or uniformly scaling the whole piece; never enlarge a pendant or stone independently.

ART DIRECTION — premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. The pendant is the hero and the chain is its supporting line. A customer should see at a glance how the piece will sit on her.

SCENE AND BACKGROUND — a seamless warm sand-beige studio sweep, softly graded from lighter behind the jewellery to deeper at the edges, with a visible gentle floor-to-wall curve low in the frame. Standing on that floor, BEHIND the necklaces and slightly off-centre, is one smooth matte off-white ceramic vessel with a rounded organic silhouette. It is a backdrop object only: clearly out of focus, never touching or overlapping a pendant, never competing with the jewellery, and no part of the jewellery rests on it. Use this same sand sweep and same single ceramic form every time. Nothing else is in the frame — no flowers, foliage, boxes, risers, cards, fabric or second prop.

CAMERA AND CROP — the low-distortion character of an 85-100mm macro lens, held horizontally at pendant height, straight on. The pendants are completely sharp with crisp micro-detail; the chain stays sharp through the lower half and falls gently softer as it rises toward the top edge, which is what makes it read as hanging in space. The ceramic form and the sweep behind fall into creamy optical softness. The V or Vs span most of the frame width where the arms leave the top. Never crop a pendant, and never crop a station on either arm below the point where the chain exits the frame.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip light that creates a clean travelling highlight along the polished chain and pendant edges. Natural warm-gold reflections rather than flat yellow metal. Existing faceted stones receive crisp controlled specular points and believable internal colour, without invented stones, glitter, starbursts, bloom or clipped highlights. The ceramic form casts one soft directional shadow onto the sweep behind it, which gives the scene depth and proves the jewellery is hanging in front of it rather than lying on it. The fine chain stays clearly visible against the sweep along its whole run.

COMMERCIAL RETOUCHING — remove any display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design.

FINAL IDENTITY CHECK — before output, verify the number of separate necklaces, strand count, chain construction, component ledger and sequence, every connection and mounting type, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm as well that every piece is hanging rather than lying down, that every chain leaves the top edge, that no two chains touch or cross, that each pendant is the lowest point of its own V and is uncropped, and that no neck, bust, stand or hand has appeared.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, boxes, stands, flowers, text, watermarks, borders, halos, malformed metal or duplicated components.$image$;
  v_previous_id uuid;
begin
  select p.id into v_previous_id
    from public.prompts as p
   where p.kind = 'image' and p.preset_slug = 'necklace'
   order by p.created_at desc, p.id desc
   limit 1;
  if v_previous_id is null then
    raise exception 'the necklace image preset is missing';
  end if;

  perform public.validate_prompt_body('image', v_image, false);

  -- The three blocks this revision exists for, plus the suite-wide invariants.
  if position('HANGING, NOT LYING DOWN' in v_image) = 0
     or position('HOW MANY NECKLACES' in v_image) = 0
     or position('IF THE SOURCE IS ALREADY HANGING' in v_image) = 0
     or position('four clearly separated points' in v_image) = 0
     or position('SOURCE AUTHORITY' in v_image) = 0
     or position('sole visual authority' in v_image) = 0
     or position('PRIORITY ORDER' in v_image) = 0
     or position('luxury e-commerce hero' in v_image) = 0
     or position('warm luxury studio lighting' in v_image) = 0
     or position('FINAL IDENTITY CHECK' in v_image) = 0
     or position('uniformly scaling' in v_image) = 0 then
    raise exception 'the worn-V v2 prompt is missing a required block';
  end if;

  -- Nothing that argues for the flat full-length layout may survive.
  if position('OPEN CENTRE' in v_image) > 0
     or position('closed oval' in v_image) > 0
     or position('horseshoe' in v_image) > 0 then
    raise exception 'the worn-V v2 prompt still carries a full-length instruction';
  end if;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at, uses_composition, preset_slug, created_by
  )
  values (
    'image', 'Necklaces — worn V hero, hanging with ceramic backdrop', v_image,
    'openai/gpt-image-2', false, now(), false, 'necklace', v_actor
  );

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.preset_revised',
    jsonb_build_object(
      'preset', 'necklace',
      'half', 'image',
      'previous_prompt_id', v_previous_id,
      'reason', 'output came out flat and merged two necklaces into one tangle',
      'fixes', jsonb_build_array(
        'camera looks horizontally at a suspended piece, flat-lay named as wrong',
        'exact source necklace count, side by side, never touching or crossing',
        'one named ceramic prop and sand sweep so hanging is legible',
        'keep a source that is already a correct hanging composition'
      ),
      'tested_on_intake', '36f179c8-fb5b-461c-88eb-91ccea7865ba',
      'test_cost_usd', 0.080502,
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
