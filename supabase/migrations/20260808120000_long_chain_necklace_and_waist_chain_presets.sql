-- Two new style presets for the long-chain categories: `necklace` and
-- `waist-chain`. Both inserted non-current. Nothing is promoted.
--
-- WHY
--
-- Reported 2026-08-08: necklaces and waist chains come out of the satin and
-- marble presets looking like bracelets or anklets. Those presets stay good for
-- rings, earrings and the rest, so this is not a regression to fix in them — it
-- is a category the shared prompt cannot serve, for four separate reasons that
-- all push the same way:
--
--   1. CAMERA AND CROP says "Arrange flexible length compactly so the focal
--      design is large" and then "Fill roughly 82-92% of the useful square".
--      Compact-plus-fill is scale-blind: a 45 cm necklace compressed into a
--      small loop and blown up to 90% of a square is geometrically the same
--      picture as an 18 cm bracelet posed the same way.
--   2. ART DIRECTION explicitly rules out a "stretched display of length" —
--      it penalises the one cue that says the piece is long.
--   3. The audited composition classes agree with it. necklace-pendant asks for
--      a "compact, graceful oval or soft teardrop rather than a long narrow
--      measuring loop"; necklace-station asks for a "broad closed oval".
--   4. Nothing anywhere states the piece's real worn length, and an isolated
--      square macro of a closed gold loop on satin carries no scale reference
--      at all. Real catalogue photography resolves that with a bust form, a
--      model, or proportion cues — many fine links around a wide open centre.
--
-- Waist chains have a fifth, sharper problem: there is no waist-chain
-- presentation class, so the describer must pick the nearest, and the nearest
-- by wording is `flat-arc` — "Lay the same flexible bracelet or anklet in a
-- relaxed compact arc". A waist chain classified flat-arc is being *instructed*
-- to pose as an anklet.
--
-- WHAT THESE PRESETS DO DIFFERENTLY
--
-- Everything already visually accepted — SOURCE AUTHORITY, FORM AND SCALE LOCK,
-- LIGHTING, COMMERCIAL RETOUCHING, OUTPUT — is copied byte for byte from the
-- accepted satin hero (20260805115500), so the look does not drift. Only the
-- blocks that must differ were rewritten:
--
--   * a SCALE CONTRACT block naming the real worn length and the two or three
--     proportions that carry it (link count, component ratio, open centre);
--   * CAMERA AND CROP inverted — the negative space belongs INSIDE the loop,
--     not as a border around it, and the outline runs to the margins;
--   * an explicit POSE block, because these presets are self-staging;
--   * a background chosen so it cannot compete with a piece that crosses the
--     whole frame.
--
-- KNOWN DEVIATION, to watch in the acceptance run: these bodies are ~1270 and
-- ~1350 words against the house 774-830. Self-staging is most of it — the POSE
-- block has to cover pendant, station, multistrand and lariat itself, where a
-- composed preset receives one already-chosen class of ~90 words. The repo's
-- caution about long prompts (20260805160000) was about compliance bulk
-- diluting aesthetics; every word added here is art direction or scale. If the
-- generated images come back stiff or over-constrained, cut the POSE branches
-- before cutting the SCALE CONTRACT — the scale block is the whole point.
--
-- Both are uses_composition = false, for the same reason hand-chain and bag
-- are: the code-side composition classes stage a piece lying compactly on a
-- surface, which is exactly the instruction being corrected here. Injecting one
-- would send the image model two contradictory poses. The describer still
-- returns a class — it is recorded as audit metadata — it simply does not drive
-- these two prompts.

do $migration$
declare
  v_actor constant text := 'migration:20260808120000';

  -- ── shared skeleton ──────────────────────────────────────────────────────
  -- <<PIECE>> <<SCALE_CONTRACT>> <<CROP>> <<POSE>> <<BACKGROUND>> <<FINAL_EXTRA>>
  v_image_base constant text := $image$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real <<PIECE>> at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then pose the piece at its true worn length, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: open or closed topology, branches and connection points; strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. Its accidental outline, the direction the piece happens to lie, and anything overlapping it are facts about that one snapshot, not about the product. Re-pose the piece properly for retail; never reproduce the arrangement it was dumped in, and never infer the product's length from how tightly it was bunched up for that shot.

<<SCALE_CONTRACT>>

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A stylist may bend and drape only genuinely flexible chain; rigid settings, pendants, motifs, bands and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every pendant, charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, pendant or decorative run independently. Keep every component naturally aligned with its real attachment.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that fine gold chain never disappears anywhere along its run. It must read immediately as a desirable storefront hero at mobile size, not as a flat inventory record or technical diagram. Showing the piece at its true length is part of that hero image, not a compromise against it.

CAMERA AND CROP — <<CROP>>

POSE — <<POSE>>

SCENE AND BACKGROUND — <<BACKGROUND>>

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, open/closed topology, strand count, chain construction, component ledger and sequence, all connection and mounting types, hardware count, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. <<FINAL_EXTRA>>

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, props, boxes, stands, flowers, text, watermarks, borders, halos, malformed metal or duplicated components.$image$;

  -- ── necklace ─────────────────────────────────────────────────────────────
  v_necklace_scale constant text :=
'TRUE LENGTH — THIS IS A NECK-WORN NECKLACE AND MUST READ AS ONE, never as a bracelet, anklet or wrist chain. It carries roughly 40-55 cm of chain: three times round an adult wrist, and closed it passes over an adult head. Three proportions carry that reading and all three are mandatory.
- LINKS. Many dozens of small links go round the loop. Hold the photographed link gauge exactly; never thicken links, lengthen them, or use fewer of them, to make the piece fill the square. Coarsening the chain is the single change that turns a necklace into a bracelet.
- RATIO. Every pendant, station, charm, bead and stone keeps its true size against the whole chain run. A pendant that grows against the loop shrinks the necklace.
- OPEN CENTRE. The area the chain encloses is the neck opening, and it is the largest single area in the frame. Do not fill it, cross it or close it down.';

  v_necklace_crop constant text :=
'use the low-distortion character of an 85-100mm macro product lens, near-overhead, optionally with a restrained 5-15 degree rake to reveal genuine relief. Focus-stack so links, connections, settings and decorative elements are crisp. Let the necklace''s own outline occupy 90-96% of the square, running close to the top, bottom and both side margins, so the generous empty space sits INSIDE the loop instead of forming a border around it. Plain repetitive chain may touch an edge; never crop a pendant, station, junction, clasp, extender, end cap or distinctive fitting.';

  v_necklace_pose constant text :=
'lay the necklace flat, at full length, and take the arrangement from what Image 1 shows. CLOSURE VISIBLE: fasten the two real ends with that hardware alone into one broad, generous oval or soft inverted teardrop, slightly taller than wide, with clasp, extender and terminal tag gathered at the top. GENUINELY OPEN, OR NO CLOSURE VISIBLE: leave it open as a wide horseshoe, the two ends near the top and the sides sweeping down and outward — invent no clasp. ONE DOMINANT PENDANT: rest it face-readable at the lowest point of the loop, in line with its real attachment, at the end of a long visible chain run. SPACED STATIONS OR CHARMS: keep every one on the continuous chain in its exact count, order, side and spacing, running the full perimeter; the chain never terminates in a station, charm or bare cut end. TWO OR MORE JOINED STRANDS: reproduce exactly that many, with their real end connections, nesting order and relative lengths, separated only enough to read each. LARIAT OR Y: keep that exact topology, junction near centre, the drop falling in one intentional direction — do not close it into an oval. Throughout, the chain settles under its own weight in smooth relaxed curves: no taut runs, no measuring-tape layout, no coiling or bunching it smaller to fit.';

  v_necklace_background constant text :=
'Use soft pale pearl-ivory satin with a warm-neutral cream character, never a yellow or champagne colour cast. Keep the whole area enclosed by the necklace smooth, quiet and unbroken so the neck opening reads as open space; confine any broad fold to the corners outside the chain, softly out of focus, so it reads as luxurious texture rather than pattern. No hard line, fold, shadow edge or object crosses inside the loop.';

  v_necklace_final constant text :=
'Confirm too that the result still reads as neck length: many fine links around a wide open centre, every component at its true relative size, nothing that would pass for a bracelet.';

  -- ── waist chain ──────────────────────────────────────────────────────────
  v_waist_scale constant text :=
'TRUE LENGTH — THIS IS A WAIST CHAIN AND MUST READ AS ONE. It is worn round the waist or hips, not the neck, wrist or ankle, and must never pass for a necklace, bracelet or anklet. It carries roughly 70-110 cm of chain: twice a necklace, five times round an adult wrist, and closed it passes over adult hips. Four proportions carry that reading and all four are mandatory.
- LINKS. Hundreds of small links go round the loop. Hold the photographed link gauge exactly; never thicken links, lengthen them, or use fewer of them, to make the piece fill the square. Coarsening the chain is the single change that shortens a waist chain.
- RATIO. Every charm, coin, bead, tassel, station and stone keeps its true size against the whole chain run.
- ADJUSTER. A waist chain carries a long adjustable extender or hook run. Reproduce it at its real length and keep it entirely visible; the adjuster is part of the product and part of what reads as waist scale.
- OPEN CENTRE. The area the chain encloses is a wide waist opening, and it is the largest single area in the frame. Do not fill it, cross it or close it down.';

  v_waist_crop constant text :=
'use the low-distortion character of an 85-100mm macro product lens, near-overhead, optionally with a restrained 5-15 degree rake to reveal genuine relief. Focus-stack so links, connections, dangles and fittings are crisp. Let the waist chain''s own outline occupy 92-97% of the square, running right up to all four margins, so the generous empty space sits INSIDE the loop instead of forming a border around it. Plain repetitive chain may touch or briefly pass an edge where the full run genuinely will not fit; never crop a charm, dangle, coin, tassel, station, junction, hook, clasp, extender end or distinctive fitting.';

  v_waist_pose constant text :=
'lay the waist chain flat, at full length, and take the arrangement from what Image 1 shows. DEFAULT: one very large relaxed loop or broad oval spanning the whole frame, with the hook or clasp and its long extender run gathered at the top and lying fully visible — close the loop only with closure hardware the source actually has, otherwise leave the two ends apart near the top and invent nothing. IF THE FULL RUN GENUINELY WILL NOT FIT at readable detail: fold the single chain once so it lies as two smooth concentric runs. That is a drape, not a duplication — it is still ONE continuous chain, the two runs visibly join at the fold, every component still appears exactly once in its true sequence, and two separate chains are never acceptable. TWO OR MORE JOINED STRANDS OR A LAYERED DOUBLE ROW: reproduce exactly that many, with their real end connections, nesting order and relative lengths, separated only enough to read each. DANGLES: every charm, coin, bead, drop or tassel keeps its exact count, order, side and spacing along the run, each hanging outward under its own weight. Throughout, the chain settles under gravity in smooth relaxed curves: no taut runs, no measuring-tape layout, no coiling or bunching it smaller to fit.';

  v_waist_background constant text :=
'Use a seamless warm pearl-ivory studio sweep with a soft top-to-bottom tonal falloff, warm-neutral and never a yellow or champagne colour cast. Keep it completely smooth — no folds, veining, horizon or visible pattern — because a chain this long crosses the entire frame and any surface texture reads as clutter tangled in it. Hold enough tonal separation from the metal that fine chain stays clearly visible along its whole run, including where it passes the brightest part of the sweep. No props, risers or objects touching the product.';

  v_waist_final constant text :=
'Confirm too that the result still reads as waist length: a very long run of many fine links around a wide open centre, the adjuster at its real length, one continuous chain rather than two, nothing that would pass for a necklace or anklet.';

  -- ── describers ───────────────────────────────────────────────────────────
  v_necklace_describe constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the necklace; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: its outline in the frame is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall shape it forms — no "laid in a rough square", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; construction and topology, including strand count, chain type and link gauge, branches and connections; the length of the chain run stated as an approximate multiple of the largest component's width, and the extender's length as an approximate fraction of the main chain; whether a working closure is visible; a component ledger of the distinct pendants, charms, motifs, stations, beads and individually separated stones, ordered by their sequence ALONG THE STRAND starting from the clasp end and moving toward the far end, preserving irregular spacing and every asymmetry; each component's shape, colour, cut, relative size and mounting method; central feature silhouette and relief; and clasp, extender and terminal-tag count and type.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- The two length proportions are required even when a count is withheld. They are what stops the next stage rendering a neck-length necklace as a bracelet, and they are the most valuable facts in this record. If the paragraph is running long, drop finish adjectives before dropping them.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- Distinguish a drilled, dangling or jump-ring-mounted charm from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones. Report faint, colourless and clear stones as carefully as coloured ones.
- Preserve side-specific order and every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

Choose exactly one presentation class, from the necklace classes only: necklace-pendant for one dominant pendant or central drop; necklace-station for a single strand with spaced fixed or dangling stations and no dominant pendant; necklace-multistrand for two or more joined parallel strands; necklace-lariat for an open Y-shaped necklace with a junction and drop; flat-curve for a plain or continuously decorated chain that fits none of those four. Never choose flat-arc or angled-band: those mean bracelet, anklet or bangle, and this is a necklace.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"<necklace-pendant|necklace-station|necklace-multistrand|necklace-lariat|flat-curve>"}$describe$;

  v_waist_describe constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the waist chain; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: its outline in the frame is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall shape it forms — no "laid in a rough square", "a loose loop", "coiled", "doubled over", "a shallow V". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; construction and topology, including strand count, layered rows, chain type and link gauge, branches and connections; the length of the chain run stated as an approximate multiple of the largest component's width, and the hook or extender run stated as an approximate fraction of the main chain; whether a working closure is visible; a component ledger of the distinct charms, coins, beads, drops, tassels, stations and individually separated stones, ordered by their sequence ALONG THE STRAND starting from the clasp or hook end and moving toward the far end, preserving irregular spacing and every asymmetry; each component's shape, colour, cut, relative size and whether it hangs freely or is fixed in line with the chain; and clasp, hook, extender and terminal-tag count and type.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- The two length proportions are required even when a count is withheld. They are what stops the next stage rendering a waist-length chain as a necklace or anklet, and they are the most valuable facts in this record. If the paragraph is running long, drop finish adjectives before dropping them.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- Distinguish a freely dangling charm, coin or tassel from a station fixed in line with the chain, and a jump-ring mounting from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones.
- Preserve side-specific order and every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

Choose exactly one presentation class: flat-curve for a single-strand waist chain; necklace-multistrand for two or more joined parallel strands or a layered double row; necklace-lariat for an open design with a junction and a hanging drop or tassel. Never choose flat-arc or angled-band: those mean bracelet, anklet or bangle, and a waist chain is several times longer.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"<flat-curve|necklace-multistrand|necklace-lariat>"}$describe$;

  v_necklace_image text;
  v_waist_image text;
begin
  if exists (select 1 from public.prompts where preset_slug in ('necklace', 'waist-chain')) then
    raise exception 'the necklace/waist-chain presets already exist — has this migration already run?';
  end if;

  v_necklace_image := v_image_base;
  v_necklace_image := replace(v_necklace_image, '<<PIECE>>', 'necklace');
  v_necklace_image := replace(v_necklace_image, '<<SCALE_CONTRACT>>', v_necklace_scale);
  v_necklace_image := replace(v_necklace_image, '<<CROP>>', v_necklace_crop);
  v_necklace_image := replace(v_necklace_image, '<<POSE>>', v_necklace_pose);
  v_necklace_image := replace(v_necklace_image, '<<BACKGROUND>>', v_necklace_background);
  v_necklace_image := replace(v_necklace_image, '<<FINAL_EXTRA>>', v_necklace_final);

  v_waist_image := v_image_base;
  v_waist_image := replace(v_waist_image, '<<PIECE>>', 'waist chain');
  v_waist_image := replace(v_waist_image, '<<SCALE_CONTRACT>>', v_waist_scale);
  v_waist_image := replace(v_waist_image, '<<CROP>>', v_waist_crop);
  v_waist_image := replace(v_waist_image, '<<POSE>>', v_waist_pose);
  v_waist_image := replace(v_waist_image, '<<BACKGROUND>>', v_waist_background);
  v_waist_image := replace(v_waist_image, '<<FINAL_EXTRA>>', v_waist_final);

  -- An unsubstituted placeholder ships a prompt containing literal "<<CROP>>",
  -- which the image model reads as instruction. Cheap to check, expensive to miss.
  if position('<<' in v_necklace_image) > 0 or position('<<' in v_waist_image) > 0 then
    raise exception 'a prompt placeholder was left unsubstituted';
  end if;

  -- Both presets stage the product themselves, so neither may carry the
  -- composition token; validate_prompt_body enforces that in both directions.
  perform public.validate_prompt_body('describe', v_necklace_describe, false);
  perform public.validate_prompt_body('describe', v_waist_describe, false);
  perform public.validate_prompt_body('image', v_necklace_image, false);
  perform public.validate_prompt_body('image', v_waist_image, false);

  -- The invariants the rest of the preset suite is held to, plus the two this
  -- migration exists to add.
  if position('SOURCE AUTHORITY' in v_necklace_image) = 0
     or position('PRIORITY ORDER' in v_necklace_image) = 0
     or position('FINAL IDENTITY CHECK' in v_necklace_image) = 0
     or position('TRUE LENGTH' in v_necklace_image) = 0
     or position('INSIDE the loop' in v_necklace_image) = 0
     or position('SOURCE AUTHORITY' in v_waist_image) = 0
     or position('PRIORITY ORDER' in v_waist_image) = 0
     or position('FINAL IDENTITY CHECK' in v_waist_image) = 0
     or position('TRUE LENGTH' in v_waist_image) = 0
     or position('INSIDE the loop' in v_waist_image) = 0 then
    raise exception 'a long-chain image prompt is missing a required block';
  end if;
  if position('Describe the object, not the photograph' in v_necklace_describe) = 0
     or position('WITHOUT a total' in v_necklace_describe) = 0
     or position('80 to 200 words' in v_necklace_describe) = 0
     or position('Describe the object, not the photograph' in v_waist_describe) = 0
     or position('WITHOUT a total' in v_waist_describe) = 0
     or position('80 to 200 words' in v_waist_describe) = 0 then
    raise exception 'a long-chain describer is missing a required rule';
  end if;

  -- Non-current and archived, like every other preset revision. A prompt change
  -- alters every product's look and is never a side effect of deployment (D51).
  insert into public.prompts (
    kind, name, body, model, is_default, archived_at, uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Necklaces — length-aware inspector', v_necklace_describe,
     'moonshotai/kimi-k3', false, now(), true, 'necklace', v_actor),
    ('image', 'Necklaces — full-length luxury hero', v_necklace_image,
     'openai/gpt-image-2', false, now(), false, 'necklace', v_actor),

    ('describe', 'Waist chains — length-aware inspector', v_waist_describe,
     'moonshotai/kimi-k3', false, now(), true, 'waist-chain', v_actor),
    ('image', 'Waist chains — full-length luxury hero', v_waist_image,
     'openai/gpt-image-2', false, now(), false, 'waist-chain', v_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.preset_created',
    jsonb_build_object(
      'presets', jsonb_build_array('necklace', 'waist-chain'),
      'reason', 'long chains rendered at bracelet or anklet scale under the shared satin/marble art direction',
      'root_causes', jsonb_build_array(
        'compact-arrangement-plus-frame-fill-is-scale-blind',
        'art-direction-penalised-display-of-length',
        'composition-classes-ask-for-a-compact-oval',
        'no-stated-worn-length-or-scale-reference',
        'no-waist-chain-class-nearest-is-flat-arc-which-means-anklet'
      ),
      'self_staging', true,
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
