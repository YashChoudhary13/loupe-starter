/**
 * The prompt matrix: one protection core per category, one scene paragraph per
 * setting, combined at save time.
 *
 * A category core is the part of an image prompt that defends the product — the
 * identity ledger, the scale contract, the pose, the count rules, the final
 * check. It is self-staging: the prompt itself states how the piece is posed, so
 * no core carries {{COMPOSITION_DETAIL}}. Every core carries exactly one
 * {{SETTING_DETAIL}} where the scene paragraph goes, and exactly one PRODUCT
 * block. Callers replace {{SETTING_DETAIL}} with a setting's scene before the
 * prompt is stored; it never reaches the model.
 *
 * Six cores (necklace, waist-chain, chain-bracelet, anklet, hand-chain, bag) are
 * extracted from the newest migration that shipped them, with only their
 * scene/surface/background paragraph swapped for the token. The remaining cores
 * are written to the same skeleton.
 *
 * Pure data and two lookups. No imports, no side effects.
 */

export interface PromptSetting {
  readonly slug: string
  readonly label: string
  readonly note: string
  /** Full scene paragraph: surface, palette, props, light character, shadow behaviour, background falloff. Photographic language. 60-140 words. */
  readonly scene: string
  /** Category slugs this setting flatters most (advisory ordering only). */
  readonly bestFor: readonly string[]
}

export interface PromptCategoryCore {
  readonly slug: string
  readonly label: string
  readonly note: string
  readonly describeBody: string
  /** Contains PRODUCT block + one {{SETTING_DETAIL}}, self-staging pose text, all protection sections. */
  readonly imageBody: string
}

export const PROMPT_SETTINGS: readonly PromptSetting[] = [
  {
    slug: 'ivory-seamless',
    label: 'Ivory seamless sweep',
    note: 'The default clean e-commerce scene when nothing should compete with the piece.',
    scene: `A seamless off-white studio sweep, warm-neutral and completely free of props: one continuous plane of soft ivory curving up behind the product with no visible horizon, seam, fold, veining or pattern. Light is broad diffused daylight from a large source overhead and slightly forward, giving even, almost shadowless illumination across the whole field with a gentle tonal falloff toward the corners. Directly beneath the product sits one small, soft, low-contrast contact shadow — enough to ground it, never enough to darken the sweep. Hold the background a shade lighter than the metal so fine chain and thin wire never disappear against it. Clean, floating, catalogue-neutral; nothing else appears in the frame.`,
    bestFor: [
      'necklace',
      'anklet',
      'hand-chain',
      'waist-chain',
      'nose-pin',
      'hair-accessory',
      'bag',
    ],
  },
  {
    slug: 'ceramic-vase-beige',
    label: 'Beige sweep, ceramic vase',
    note: 'Warm sculptural backdrop for a hero piece that needs depth behind it.',
    scene: `A seamless warm beige-to-tan studio sweep with a soft top-to-bottom gradient and a gentle floor-to-wall curve low in the frame. Standing on that floor behind the product and slightly off-centre is one matte white ceramic donut vase — a smooth ring-shaped organic form — thrown well out of focus so it reads as sculpture rather than as an object in the shot. Soft diffused daylight enters from the upper right, wrapping the sweep warmly and modelling the ceramic with a broad quiet gradient. The vase casts one soft directional shadow onto the sand-beige field behind it, and the product carries its own small diffused contact shadow. Warm, tactile, gallery-quiet; no second prop, foliage, riser or hard line anywhere.`,
    bestFor: ['necklace'],
  },
  {
    slug: 'white-plinth',
    label: 'White plinth, catalogue clean',
    note: 'Scandinavian catalogue look — a cropped ceramic plinth edge and one honest drop shadow.',
    scene: `A pure white seamless sweep, cool-neutral and evenly lit, with a low white ceramic plinth — a short cylinder or the wide shallow edge of a bowl — cropped by the frame and serving as the display surface. Its glazed matte face is smooth and unpatterned, and the join between plinth and sweep is soft enough that the two read as one continuous white field. Light is a single large diffused source from front-left at a shallow height, producing one clean soft grey drop shadow that falls to one side and grounds the object. Highlights stay controlled and the whites stay white without clipping. Restrained catalogue clarity: no colour cast, no texture, no second prop.`,
    bestFor: ['necklace', 'bag', 'hair-accessory'],
  },
  {
    slug: 'bridal-blossom',
    label: 'Bridal blossom, high key',
    note: 'Bright romantic bridal scene for pieces sold into wedding sets.',
    scene: `A pale cream marble surface with the faintest warm-grey veining, polished only to a low satin sheen rather than a mirror, so it reads close to ivory silk. Set far back in the upper corners, well away from the product, are blurred sprays of small white jasmine blossoms and pale buds — so heavily out of focus that they read as soft light-shapes rather than as flowers. High-key daylight floods in from a large window at front-left, bright and airy, lifting the whole frame toward white with only the gentlest falloff at the edges. Shadows are pale, soft and short. Romantic bridal morning light: luminous, fresh, tender, with generous clean space around the product.`,
    bestFor: ['necklace', 'earrings', 'rings', 'indian-jewellery'],
  },
  {
    slug: 'cream-silk-window',
    label: 'Cream silk, window shadow',
    note: 'Quiet-luxury interior with a hard diagonal window shadow for graphic structure.',
    scene: `A cream silk drape laid as the surface, falling into slow rolling folds that run out of the frame, its sheen soft and warm rather than glossy. Behind it rises a panelled wall in the same warm off-white, and across that wall falls one hard diagonal shadow cast by an unseen window frame — a crisp bright band beside a quieter one, holding the whole frame together. The daylight is directional and low, raking from the side so the folds read as gently sculpted ridges with long soft valleys. Colour stays warm-neutral with no yellow cast, and the deepest fold shadows keep detail. Quiet-luxury interior stillness: no flowers, no risers, nothing resting on the silk beside the product.`,
    bestFor: ['necklace', 'anklet', 'hand-chain', 'waist-chain', 'hair-accessory'],
  },
  {
    slug: 'navy-satin-roll',
    label: 'Navy satin bolster',
    note: 'Low-key cinematic drama; the rolled bolster gives long pieces something to fall across.',
    scene: `Deep navy satin rolled into a long cylindrical bolster lying across the lower frame, its face catching liquid highlights along the curve and falling into rich blue shadow beneath. Behind it the background deepens through a midnight-blue gradient to near-black at the corners, with no visible horizon. Where the staged pose allows, the roll is the surface the product rests on or falls across. Lighting is low-key and cinematic: one directional key from the upper left, tight and slightly hard, with very little fill, so warm gold reflections travel along polished metal and the satin sheen carries the eye. Shadows are deep, clean and warm-edged. Jewel-box drama; nothing else appears in the frame.`,
    bestFor: ['necklace', 'chain-bracelet', 'watch'],
  },
  {
    slug: 'black-marble-mirror',
    label: 'Black marble mirror',
    note: 'Graphic high-contrast stage where a wet-look reflection doubles the piece.',
    scene: `A slab of polished black marble with fine white veining, buffed to a wet-look mirror so a soft inverted reflection falls directly beneath the product and fades within a short distance. The veining is sparse and kept away from the centre of the frame. A hard grazing sidelight skims across the stone from the left, picking out the polish as a long specular sheen and throwing one crisp narrow shadow to the opposite side; fill is minimal but never lets the form go black. Behind the slab the background falls away to pure black with no visible horizon or seam. Cool, graphic and expensive, with a single controlled highlight travelling along every polished edge.`,
    bestFor: ['rings', 'kada-bracelet', 'chain-bracelet', 'watch'],
  },
  {
    slug: 'emerald-velvet',
    label: 'Emerald velvet, gold zari',
    note: 'Festive Indian jewel-box mood; green sets off warm gold and kundan work.',
    scene: `Deep emerald velvet sculpted into soft low folds that radiate away from the centre, its pile catching light as a bloom of lighter green along each ridge and sinking to near-black in the troughs. Behind it, thrown well out of focus, hangs gold zari brocade whose woven metallic pattern reads only as a warm shimmer rather than as a legible motif. A soft key falls from the upper left, broad but clearly directional, so the velvet gradates from a luminous pool at the centre out to a dark green vignette at the corners. Warm gold reflections sit richly against the cool green. Festive jewel-box mood: no additional props, boxes, flowers or objects in the frame.`,
    bestFor: ['earrings', 'indian-jewellery'],
  },
  {
    slug: 'rosewood-velvet',
    label: 'Rosewood lid, maroon velvet',
    note: 'Heritage monsoon-luxury scene for heavier metal and dark-toned sets.',
    scene: `The polished lid of a dark rosewood box fills the lower frame as the surface — deep red-brown grain under a glossy lacquer, with fine water droplets beaded across it catching tiny points of light. Behind it hangs deep maroon crushed velvet, its crumpled sheen thrown softly out of focus into a warm dark field. A single warm cinematic key enters from the upper left, low and directional, raking the lacquer into a long soft sheen and lighting each droplet as a small bright bead. Fill is low and the shadows stay warm rather than black, holding detail in the grain. Heritage monsoon-luxury: rich, dark and still, with no additional props or objects in the frame.`,
    bestFor: ['kada-bracelet', 'chain-bracelet', 'watch', 'indian-jewellery'],
  },
  {
    slug: 'sunlit-stone',
    label: 'Sunlit stone, window pane',
    note: 'Architectural daylight with a crisp cast shadow; flatters small pieces and flat lays.',
    scene: `A warm beige plaster and limestone surface, matte and faintly grainy, running back to a wall of the same material with no visible seam. Hard afternoon sun enters from the upper left through an unseen window, laying a crisp geometric window-pane shadow in bright rectangles across the stone, and fine dust motes drift and glint inside the beam. The direct sun throws one long, elegant, sharp-edged shadow from the product across the surface, while the areas outside the beam sit in warm gently filled shade that keeps its detail. Colour runs warm sand and honey with clean neutral whites. Architectural Mediterranean calm: still, sunlit and unpeopled, with no props or foliage beside the product.`,
    bestFor: [
      'rings',
      'nose-pin',
      'watch',
      'anklet',
      'hand-chain',
      'waist-chain',
      'bag',
    ],
  },
]

export const PROMPT_CATEGORY_CORES: readonly PromptCategoryCore[] = [
  {
    slug: 'necklace',
    label: 'Necklaces',
    note: 'Keeps the piece hanging in mid-air as a narrow V at true neck length, and never merges two necklaces into one.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the necklace; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

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
{"description":"<one factual 80-200 word paragraph>","presentation":"<necklace-pendant|necklace-station|necklace-multistrand|necklace-lariat|flat-curve>"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real jewellery at its most flattering; improve only its presentation, never its design.

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

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Take from that scene only its surfaces, palette, backdrop elements, light character and shadow behaviour. The necklaces are never laid on any of it: any surface it names is a floor or backdrop standing BEHIND and BELOW the hanging pieces, never something they rest on, and no contact shadow of the jewellery falls on it. Everything the scene places in the frame is backdrop only — clearly out of focus, never touching or overlapping a pendant, never competing with the jewellery, and no part of the jewellery rests on it. Nothing else is in the frame.

CAMERA AND CROP — the low-distortion character of an 85-100mm macro lens, held horizontally at pendant height, straight on. The pendants are completely sharp with crisp micro-detail; the chain stays sharp through the lower half and falls gently softer as it rises toward the top edge, which is what makes it read as hanging in space. Whatever stands behind the piece, and the backdrop itself, fall into creamy optical softness. The V or Vs span most of the frame width where the arms leave the top. Never crop a pendant, and never crop a station on either arm below the point where the chain exits the frame.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip light that creates a clean travelling highlight along the polished chain and pendant edges. Natural warm-gold reflections rather than flat yellow metal. Existing faceted stones receive crisp controlled specular points and believable internal colour, without invented stones, glitter, starbursts, bloom or clipped highlights. Whatever stands in the scene casts its own soft directional shadow onto the backdrop behind it, which gives the scene depth and proves the jewellery is hanging in front of it rather than lying on it. The fine chain stays clearly visible against the background along its whole run, including where it crosses the brightest or darkest part of the scene.

COMMERCIAL RETOUCHING — remove any display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design.

FINAL IDENTITY CHECK — before output, verify the number of separate necklaces, strand count, chain construction, component ledger and sequence, every connection and mounting type, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm as well that every piece is hanging rather than lying down, that every chain leaves the top edge, that no two chains touch or cross, that each pendant is the lowest point of its own V and is uncropped, and that no neck, bust, stand or hand has appeared.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no object beyond the backdrop elements the scene paragraph itself names.`,
  },
  {
    slug: 'waist-chain',
    label: 'Waist chains',
    note: 'Holds 70-110 cm of chain at true waist scale, one continuous run rather than two, with the adjuster visible.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the waist chain; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

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
{"description":"<one factual 80-200 word paragraph>","presentation":"<flat-curve|necklace-multistrand|necklace-lariat>"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real waist chain at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then pose the piece at its true worn length, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: open or closed topology, branches and connection points; strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. Its accidental outline, the direction the piece happens to lie, and anything overlapping it are facts about that one snapshot, not about the product. Re-pose the piece properly for retail; never reproduce the arrangement it was dumped in, and never infer the product's length from how tightly it was bunched up for that shot.

TRUE LENGTH — THIS IS A WAIST CHAIN AND MUST READ AS ONE. It is worn round the waist or hips, not the neck, wrist or ankle, and must never pass for a necklace, bracelet or anklet. It carries roughly 70-110 cm of chain: twice a necklace, five times round an adult wrist, and closed it passes over adult hips. Four proportions carry that reading and all four are mandatory.
- LINKS. Hundreds of small links go round the loop. Hold the photographed link gauge exactly; never thicken links, lengthen them, or use fewer of them, to make the piece fill the square. Coarsening the chain is the single change that shortens a waist chain.
- RATIO. Every charm, coin, bead, tassel, station and stone keeps its true size against the whole chain run.
- ADJUSTER. A waist chain carries a long adjustable extender or hook run. Reproduce it at its real length and keep it entirely visible; the adjuster is part of the product and part of what reads as waist scale.
- OPEN CENTRE. The area the chain encloses is a wide waist opening, and it is the largest single area in the frame. Do not fill it, cross it or close it down.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A stylist may bend and drape only genuinely flexible chain; rigid settings, pendants, motifs, bands and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every pendant, charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, pendant or decorative run independently. Keep every component naturally aligned with its real attachment.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that fine gold chain never disappears anywhere along its run. It must read immediately as a desirable storefront hero at mobile size, not as a flat inventory record or technical diagram. Showing the piece at its true length is part of that hero image, not a compromise against it.

CAMERA AND CROP — use the low-distortion character of an 85-100mm macro product lens, near-overhead, optionally with a restrained 5-15 degree rake to reveal genuine relief. Focus-stack so links, connections, dangles and fittings are crisp. Let the waist chain's own outline occupy 92-97% of the square, running right up to all four margins, so the generous empty space sits INSIDE the loop instead of forming a border around it. Plain repetitive chain may touch or briefly pass an edge where the full run genuinely will not fit; never crop a charm, dangle, coin, tassel, station, junction, hook, clasp, extender end or distinctive fitting.

POSE — lay the waist chain flat, at full length, and take the arrangement from what Image 1 shows. DEFAULT: one very large relaxed loop or broad oval spanning the whole frame, with the hook or clasp and its long extender run gathered at the top and lying fully visible — close the loop only with closure hardware the source actually has, otherwise leave the two ends apart near the top and invent nothing. IF THE FULL RUN GENUINELY WILL NOT FIT at readable detail: fold the single chain once so it lies as two smooth concentric runs. That is a drape, not a duplication — it is still ONE continuous chain, the two runs visibly join at the fold, every component still appears exactly once in its true sequence, and two separate chains are never acceptable. TWO OR MORE JOINED STRANDS OR A LAYERED DOUBLE ROW: reproduce exactly that many, with their real end connections, nesting order and relative lengths, separated only enough to read each. DANGLES: every charm, coin, bead, drop or tassel keeps its exact count, order, side and spacing along the run, each hanging outward under its own weight. Throughout, the chain settles under gravity in smooth relaxed curves: no taut runs, no measuring-tape layout, no coiling or bunching it smaller to fit.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the field the chain crosses quiet: a chain this long runs across the entire frame, and any busy texture, hard line, fold edge or pattern beneath it reads as clutter tangled in the product. Hold enough tonal separation from the metal that fine chain stays clearly visible along its whole run, including where it passes the brightest and the darkest part of the scene, and keep the area enclosed by the chain unbroken so the waist opening reads as open space. No prop, riser or object beyond those the scene itself names, and nothing touching, crossing or overlapping the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, open/closed topology, strand count, chain construction, component ledger and sequence, all connection and mounting types, hardware count, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the result still reads as waist length: a very long run of many fine links around a wide open centre, the adjuster at its real length, one continuous chain rather than two, nothing that would pass for a necklace or anklet.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  // <<CORES>>
]

export function categoryCore(slug: string): PromptCategoryCore | null {
  return PROMPT_CATEGORY_CORES.find((core) => core.slug === slug) ?? null
}

export function promptSetting(slug: string): PromptSetting | null {
  return PROMPT_SETTINGS.find((setting) => setting.slug === slug) ?? null
}

/** bestFor matches first, in declaration order, then everything else. */
export function settingsForCategory(
  categorySlug: string,
): readonly PromptSetting[] {
  return [
    ...PROMPT_SETTINGS.filter((setting) => setting.bestFor.includes(categorySlug)),
    ...PROMPT_SETTINGS.filter((setting) => !setting.bestFor.includes(categorySlug)),
  ]
}
