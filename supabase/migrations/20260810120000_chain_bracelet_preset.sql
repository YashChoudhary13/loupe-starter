-- One new style preset for the wrist-chain category: `chain-bracelet`.
-- Inserted non-current. Nothing is promoted.
--
-- WHY
--
-- Reported 2026-08-10: chain bracelets come out of the satin preset posed as
-- wide open ovals that read as necklaces. Verified against that morning's live
-- batch — intakes a5aed1e5 (IMG20260810145953) and 43794a1d (IMG20260810150320)
-- both produced necklace-scale loops with the short extender swollen into a
-- heavy feature chain at roughly three times its true gauge. This is the exact
-- failure 20260808120000 fixed for necklaces and waist chains, arriving from
-- the opposite direction: compact-arrangement-plus-frame-fill is scale-blind,
-- so an 18 cm bracelet blown up to 90% of a square is geometrically the same
-- picture as a 45 cm necklace posed the same way. Nothing states the worn
-- length, so the image model picks a scale story at random.
--
-- The describer compounds it. On both failures the shared inspector hedged the
-- category — "bracelet or anklet", "anklet or bracelet" — so the image stage
-- never even received the word bracelet, and one hedge ("a disc with a slightly
-- curved or heart-like silhouette") was materialised as an invented literal
-- heart charm.
--
-- WHAT THIS PRESET DOES DIFFERENTLY
--
-- Everything already visually accepted — SOURCE AUTHORITY, FORM AND SCALE LOCK,
-- SCENE AND BACKGROUND, LIGHTING, COMMERCIAL RETOUCHING, OUTPUT — is copied
-- byte for byte from the live satin hero, so chain bracelets keep the house
-- pearl-ivory look and sit beside the rest of the satin catalogue. Only the
-- blocks that must differ were written:
--
--   * a TRUE SIZE block naming the real worn length and the three proportions
--     that carry it (countable links, components large against the loop, the
--     extender at its true fraction and gauge — the third one aimed squarely
--     at the swollen-extender failure);
--   * an explicit POSE block (self-staging): fasten the real closure into a
--     small relaxed circle, or a compact arc when no closure is visible;
--   * CAMERA AND CROP keeps the whole piece inside the frame — on a bracelet
--     the clasp and extender are scale evidence, not hardware to push off an
--     edge;
--   * a category-committed describer that must call the piece a chain bracelet,
--     never hedge, and always report the two length proportions.
--
-- uses_composition = false, like necklace, waist-chain, hand-chain and bag: the
-- shared flat-arc class would instruct the exact anklet-adjacent lay this
-- preset exists to replace. The describer still returns a class — flat-arc,
-- fixed — as audit metadata; it does not drive this prompt.

do $migration$
declare
  v_actor constant text := 'migration:20260810120000';

  v_image constant text := $image$Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real chain bracelet at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then pose the piece at its true wrist size, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: open or closed topology, branches and connection points; strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

TRUE SIZE — THIS IS A WRIST-WORN CHAIN BRACELET AND MUST READ AS ONE, never as a necklace or waist chain. It carries roughly 16-19 cm of chain plus a short extender: once round an adult wrist, about a third of a necklace, and fastened it forms a small circle scarcely wider than a palm. Three proportions carry that reading and all three are mandatory.
- LINKS. A modest, countable number of links go round the loop — dozens, not hundreds. Hold the photographed link gauge exactly; never render the links finer or more numerous so the piece can sweep wider across the square. Refining and multiplying the chain is the single change that turns a bracelet into a necklace.
- RATIO. Every charm, station, disc and stone keeps its true size against the whole chain run, and on a wrist chain those components sit LARGE against the loop. Shrinking a charm against its chain lengthens the piece into a necklace.
- EXTENDER. A bracelet's extender is a meaningful fraction of its main chain — often a quarter to a third — with links one readable step larger than the main run. Reproduce the photographed extender at exactly that relative length and link size: never let it swell into a heavy feature chain, and never trim it to a token tail. The clasp and extender stay fully visible inside the frame; on a bracelet they are part of the design story, not hardware to hide.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A stylist may bend and drape only genuinely flexible chain; rigid settings, pendants, motifs, bands and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every pendant, charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, pendant or decorative run independently. Keep every component naturally aligned with its real attachment.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. Its accidental outline, the direction the piece happens to lie, and anything overlapping it are facts about that one snapshot, not about the product. Re-pose the piece properly for retail; never reproduce the arrangement it was dumped in, and never infer the product's length from how loosely or tightly it was laid out for that shot.

POSE — lay the bracelet flat and take the arrangement from what Image 1 shows. CLOSURE VISIBLE: fasten the two real ends using only that hardware into one relaxed, softly rounded circle with natural slack — an easy organic round, never a taut geometric ring and never a wide necklace oval — with the clasp and its extender lying together naturally along the upper part of the curve. GENUINELY OPEN, OR NO CLOSURE VISIBLE: lay the piece at full length in one relaxed compact arc or soft S; invent no clasp. CHARMS, STATIONS AND DANGLES: every one stays on the continuous chain in its exact count, order, side placement and spacing, dangling charms settling outward from the curve under their own weight, none flipped, stacked or tangled. Throughout, the chain settles under its own weight in smooth relaxed curves: no taut runs, no measuring-tape layout, no bunching the piece smaller to fit.

HOW MANY — count the separate bracelets in Image 1 and render EXACTLY that many. One bracelet sits centred. Two or more lie side by side, evenly spaced, each posed completely with its own closure state; they must not touch, cross, overlap or share a chain, and no piece is ever duplicated, mirrored or merged into another.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that fine gold chain does not disappear. It must read immediately as a desirable storefront hero at mobile size — and immediately as a piece worn on a wrist — not as a flat inventory record or technical diagram.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, near-overhead, optionally with a restrained 5-15 degree rake to reveal genuine relief. Focus-stack the complete jewellery design so links, connections, settings, charms, clasp and extender are crisp. Let the posed bracelet fill roughly 78-88% of the useful square with breathing room in the corners. The complete piece stays inside the frame: never crop a charm, station, junction, clasp, extender, end cap, terminal tag or distinctive fitting, and never push chain off an edge — a bracelet fits its frame whole, and showing it whole is part of what reads as wrist size.

SCENE AND BACKGROUND — Use soft pale pearl-ivory satin with a warm-neutral cream character, never a yellow or champagne colour cast. Keep the centre beneath the jewellery quiet and nearly smooth; place one or two broad natural folds toward the outer edges, softly out of focus so they read as luxurious texture rather than pattern. No hard lines or objects touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key from upper-left/front, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, open/closed topology, strand count, chain construction, component ledger and sequence, all connection and mounting types, hardware count, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the result still reads as wrist size: a small relaxed circle or compact arc of clearly resolvable links, components large against the loop, the clasp and extender present at their true fraction and gauge, nothing that would pass for a necklace.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, props, boxes, stands, flowers, text, watermarks, borders, halos, malformed metal or duplicated components.$image$;

  v_describe constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the chain bracelet; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: its outline in the frame is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall shape it forms — no "laid out straight", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is a wrist-worn chain bracelet. Name it as exactly that: never call it a necklace or an anklet, and never hedge between categories — "bracelet or anklet" sends the posing stage hunting for the wrong scale.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; construction and topology, including strand count, chain type and link gauge, branches and connections; the length of the chain run stated as an approximate multiple of the largest component's width, and the extender's length as an approximate fraction of the main chain; whether a working closure is visible; a component ledger of the distinct charms, stations, discs, motifs, beads and individually separated stones, ordered by their sequence ALONG THE STRAND starting from the clasp end and moving toward the far end, preserving irregular spacing and every asymmetry; each component's shape, colour, cut, relative size and mounting method; and clasp, extender and terminal-tag count and type.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- The two length proportions are required even when a count is withheld. They are what stops the next stage rendering a wrist-length bracelet as a neck-length necklace, and they are the most valuable facts in this record. If the paragraph is running long, drop finish adjectives before dropping them.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- Distinguish a drilled, dangling or jump-ring-mounted charm from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones. Report faint, colourless and clear stones as carefully as coloured ones.
- Preserve side-specific order and every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

The presentation class is fixed for this inspection: a flexible wrist chain is flat-arc. Never return a necklace class — those mean neck length — and never angled-band, which means a rigid bangle or kada.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"flat-arc"}$describe$;
begin
  if exists (select 1 from public.prompts where preset_slug = 'chain-bracelet') then
    raise exception 'the chain-bracelet preset already exists — has this migration already run?';
  end if;

  -- Self-staging, so the image prompt must not carry the composition token;
  -- validate_prompt_body enforces that in both directions.
  perform public.validate_prompt_body('describe', v_describe, false);
  perform public.validate_prompt_body('image', v_image, false);

  -- The invariants the rest of the preset suite is held to, plus the ones this
  -- migration exists to add.
  if position('SOURCE AUTHORITY' in v_image) = 0
     or position('PRIORITY ORDER' in v_image) = 0
     or position('FINAL IDENTITY CHECK' in v_image) = 0
     or position('TRUE SIZE' in v_image) = 0
     or position('EXTENDER' in v_image) = 0
     or position('reads as wrist size' in v_image) = 0 then
    raise exception 'the chain-bracelet image prompt is missing a required block';
  end if;
  if position('Describe the object, not the photograph' in v_describe) = 0
     or position('WITHOUT a total' in v_describe) = 0
     or position('80 to 200 words' in v_describe) = 0
     or position('never call it a necklace' in v_describe) = 0 then
    raise exception 'the chain-bracelet describer is missing a required rule';
  end if;

  -- Non-current and archived, like every other preset revision. A prompt change
  -- alters every product's look and is never a side effect of deployment (D51).
  insert into public.prompts (
    kind, name, body, model, is_default, archived_at, uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Chain bracelets — length-aware inspector', v_describe,
     'moonshotai/kimi-k3', false, now(), true, 'chain-bracelet', v_actor),
    ('image', 'Chain bracelets — wrist-scale hero', v_image,
     'openai/gpt-image-2', false, now(), false, 'chain-bracelet', v_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.preset_created',
    jsonb_build_object(
      'presets', jsonb_build_array('chain-bracelet'),
      'reason', 'chain bracelets rendered at necklace scale under the shared satin art direction',
      'root_causes', jsonb_build_array(
        'compact-arrangement-plus-frame-fill-is-scale-blind',
        'describer-hedged-bracelet-or-anklet-so-the-image-stage-never-received-the-category',
        'extender-rendered-far-over-its-true-gauge-with-no-stated-proportion',
        'no-stated-worn-length-or-scale-reference'
      ),
      'self_staging', true,
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
