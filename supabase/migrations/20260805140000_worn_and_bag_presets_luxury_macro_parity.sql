-- Bring the hand-chain and bag presets up to the protected luxury macro standard.
--
-- 20260805115500 rewrote satin, marble and yellow into the "protected luxury
-- macro hero" shape that the owner confirmed works: an explicit PRIORITY ORDER,
-- a non-negotiable SOURCE AUTHORITY ledger, a FORM AND SCALE LOCK, positive ART
-- DIRECTION, a named CAMERA AND CROP, and a FINAL IDENTITY CHECK before output.
-- It left hand-chain and bag on the 2026-08-04 "faithful premium retail hero"
-- text, so those two presets were two revisions behind and produced visibly
-- flatter results.
--
-- They cannot simply take the default with its scene swapped: both stage the
-- product themselves (worn on a hand, a bag standing), so they carry no
-- {{COMPOSITION_DETAIL}} token and their pose section is written in. Everything
-- else follows the default section for section, in the same order and voice.
--
-- Inserted non-current, exactly like every other preset: an operator promotes
-- one deliberately in /prompts. Nothing about the live default changes here.

do $migration$
declare
  v_actor constant text := 'migration:20260805140000';

  v_hand_chain_image constant text := $handchain$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference, into the exact same hand chain worn naturally on one hand. Photograph the real jewellery at its most flattering; improve only its presentation and fit, never its design.

PRIORITY ORDER — first preserve product identity, then fit it truthfully to the hand, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: wrist section; branch and junction count; open or closed topology; strand count; chain-link construction and gauge; finger-loop and ring count; exact charm, motif and stone count, order, side placement and relative spacing; shapes, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

FORM AND SCALE LOCK — retain the product's real construction. A stylist may drape only genuinely flexible chain; rigid settings, motifs, rings and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the whole photographed scene; never enlarge a component independently. Do not reroute, stretch, merge or split any chain.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product on a real hand. Create one confident composition with a clear focal hierarchy and enough contrast that fine gold chain never disappears against skin. It must read immediately as a desirable storefront hero at mobile size, not as a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens. Frame a close three-quarter-above view of a relaxed hand with the jewellery prominent, keeping the wrist section and every fitted finger in frame. Focus-stack the complete jewellery design so links, junctions, settings and decorative elements are crisp. Never crop a junction, clasp, extender, end cap, terminal tag or distinctive fitting.

WEARING AND FIT — fit the real wrist section at the wrist, route the exact source number of chains across the back of the hand, and fit the exact source number of loops or rings onto the correct number of fingers. Use a natural relaxed pose with softly settled fingers that reveals every junction without pulling the product taut. The chain follows the hand's real contours and rests under its own weight: no floating, no tension, no invented routing.

SCENE AND BACKGROUND — one relaxed adult hand and forearm against soft pale pearl-ivory satin with a warm-neutral cream character, never a yellow or champagne colour cast. Keep the field behind the hand quiet and softly out of focus so it reads as luxurious texture rather than pattern. Natural skin texture with neat natural nails, no nail art, no rings or unrelated jewellery, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add soft, diffused contact shadows where the jewellery rests on skin so it feels physically worn.

COMMERCIAL RETOUCHING — remove the display card, packaging, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. Skin stays photorealistic with natural texture and even tone; the jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the wrist-section, branch, junction, strand, finger-loop, component and hardware counts, the chain construction, every connection and mounting type, asymmetry and relative scale against Image 1, and confirm the hand shows five natural fingers with correct anatomy. Correct the presentation rather than changing any of those facts.

OUTPUT — one opaque, photorealistic square premium retail image showing exactly one hand. No second hand, face, mannequin, props, boxes, stands, flowers, text, watermarks, borders, halos, extra or missing fingers, warped anatomy, malformed metal or duplicated components.$handchain$;

  v_bag_image constant text := $bag$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference, into the exact same bag or pouch. Photograph the real product at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then choose a truthful angle and form, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: silhouette, structure and proportions; material texture, weave, grain or pile; panel, gusset and pocket layout; closure count and type; handle and strap count, length and attachment points; hardware shape, finish and count; stitching, seams, piping, trim, artwork, lettering, colours and every visible asymmetry. Reproduce lettering and artwork exactly as photographed — never translate, restyle, correct or re-space it. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

FORM AND STRUCTURE LOCK — retain the product's real construction and believable resting geometry. A soft bag stays softly shaped and may settle naturally under its own weight; a structured bag keeps its exact structure. Do not inflate, stretch, taper, flatten, stiffen or slim the silhouette, and never invent an unseen side, base or lining. Keep every pocket, pull, buckle and decorative element at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed product; never enlarge hardware or artwork independently.

ART DIRECTION — recover the selling power of premium accessory campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful negative space and enough contrast that material texture and hardware read clearly. It must look like a desirable storefront hero at mobile size, not a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm product lens with no wide-angle stretch. Choose the angle from the real construction: near-front for a flat pouch, a gentle three-quarter view only when genuine depth is visible in the source. Focus-stack the product so weave, stitching, hardware and lettering are crisp. Fill roughly 78-88% of the useful square with clean breathing room, and never crop a handle, strap, closure, logo or distinctive fitting.

STANDING AND PRESENTATION — present the bag upright and self-supporting in its natural resting form, with handles or straps arranged deliberately rather than dropped at random: standing softly, laid where the construction demands it, or with one strap draped to reveal its real attachment. No hidden supports, stands or props may appear in frame.

SCENE AND BACKGROUND — use a polished pale white-and-cream marble surface with sparse, soft warm-grey and very pale gold veining kept well away from artwork, lettering and edges. Let the far surface fall into gentle creamy optical softness against a clean warm-neutral studio backdrop. The stone is elegant supporting texture, never a competing pattern. No props, risers, hard horizon or objects touching the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip or rim light that separates the silhouette from the background. Render material honestly — matte stays matte, grain stays grain, patent stays glossy — with controlled highlights on hardware and no artificial sheen on fabric. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove packaging, hands, price labels, tags, stickers, dust, lint and unrelated branding. Preserve real texture, seams, stitching, piping, artwork, relief and exact lettering. Clean and refine edges and micro-contrast without turning the material into smooth plastic, CGI or an upgraded product. The bag stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the silhouette and proportions, panel, pocket, gusset and closure counts, handle and strap count and attachment points, hardware count, artwork, exact lettering and spelling, colours, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, props, boxes, stands, flowers, text, watermarks, borders, halos, warped lettering, invented hardware or duplicated components.$bag$;

  v_hand_chain_describer text;
  v_bag_describer text;
begin
  -- Reuse each preset's maintained describer verbatim. Only the image stage was
  -- left behind; rewriting a working inspector would risk the identity ledger.
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

  if v_hand_chain_describer is null or v_bag_describer is null then
    raise exception 'worn/bag preset parity migration could not find both maintained describers';
  end if;

  -- Both stage the product themselves, so neither may carry a composition token.
  perform public.validate_prompt_body('image', v_hand_chain_image, false);
  perform public.validate_prompt_body('image', v_bag_image, false);

  if position('FINAL IDENTITY CHECK' in v_hand_chain_image) = 0
     or position('PRIORITY ORDER' in v_hand_chain_image) = 0
     or position('FINAL IDENTITY CHECK' in v_bag_image) = 0
     or position('PRIORITY ORDER' in v_bag_image) = 0 then
    raise exception 'worn/bag preset parity migration lost a required section';
  end if;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Hand chain — exact connection inspector', v_hand_chain_describer,
     'openai/gpt-5.6-sol', false, now(), true, 'hand-chain', v_actor),
    ('image', 'Hand chain worn — protected luxury macro hero', v_hand_chain_image,
     'openai/gpt-image-2', false, now(), false, 'hand-chain', v_actor),
    ('describe', 'Bags — exact construction inspector', v_bag_describer,
     'openai/gpt-5.6-sol', false, now(), true, 'bag', v_actor),
    ('image', 'Bags — protected luxury macro hero', v_bag_image,
     'openai/gpt-image-2', false, now(), false, 'bag', v_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system',
    null,
    'prompt.preset_revised',
    jsonb_build_object(
      'presets', jsonb_build_array('hand-chain', 'bag'),
      'reason', 'protected luxury macro parity with the satin/marble/yellow revision',
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
