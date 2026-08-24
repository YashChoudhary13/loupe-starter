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

export interface PromptMeasurement {
  readonly slug: string
  readonly label: string
  readonly note: string
  /** Inserted into the describer body immediately before its JSON contract. '' for none. */
  readonly describeRule: string
  /** Appended to the image body, after OUTPUT, so it can override OUTPUT's no-text rule. '' for none. */
  readonly imageRule: string
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

/**
 * The third axis: whether the finished photograph carries dimension callouts.
 *
 * "Measured" is a contract with the photographer, not just with the model. The
 * raw upload must show a ruler or printed scale bar lying beside the piece, in
 * the same plane and at the same distance from the camera; the describer reads
 * it and states the figures in millimetres inside its own description
 * paragraph, so no pipeline field, database column or JSON key changes. The
 * image stage then prints those exact figures as flat dimension lines and
 * removes the ruler itself from the frame.
 *
 * Because the figures travel inside the description, a measurement the
 * describer refused to make (tilted, blurred or unreadable scale) reaches the
 * image stage as "not legible" and it draws nothing — an unmeasured photograph
 * rather than an invented number.
 */
export const PROMPT_MEASUREMENTS: readonly PromptMeasurement[] = [
  {
    slug: 'plain',
    label: 'No measurements',
    note: 'The hero photograph on its own. Upload as usual; no ruler needed.',
    describeRule: '',
    imageRule: '',
  },
  {
    slug: 'measured',
    label: 'Measurements on the image',
    note: 'Photograph each piece with a ruler beside it. Loupe reads the ruler and prints dimension callouts on the finished image.',
    describeRule: `MEASUREMENT — a measuring scale (a ruler or a printed scale bar) is lying in Image 1 beside the product, as a size reference. It is a measuring aid and is NOT part of the product: never count it as a component, never enter it in the ledger, never let it change the presentation class, and never describe it as an object.

Read it before you write. Find the printed unit by reading the numerals — cm or mm — rather than assuming one, and work out how far one printed division spans in the photograph. Then measure the product with that ratio, along the same plane the scale lies in. Measure the two or three dimensions a buyer would ask for on this kind of piece: for a flexible piece, its full end-to-end length and the largest component's height and width; for a rigid piece, its outer height and width and, where it applies, its inner diameter. Measure only the product; exclude packaging, cards, the scale and anything the piece rests on.

End the description with one further sentence, inside the same single paragraph with no line break before it, in exactly this form and with nothing after it:
"Measured against the scale: <part> <number> mm; <part> <number> mm."
Use whole millimetres. Give a figure only when the scale is legible, lies flat in the same plane as the part being measured and sits at the same distance from the camera. When it is tilted, blurred, out of plane, cropped or its numerals cannot be read, write "Measured against the scale: not legible." instead and give no numbers at all. A confident wrong measurement is worse than none: it will be printed on the photograph a customer buys from.`,
    imageRule: `MEASURING SCALE IN THE SOURCE — Image 1 was photographed with a ruler or scale bar beside the piece. It is a measuring aid; it is not part of the product and not part of the scene. It never appears in the output, and no rule edge, tick mark, numeral or fragment of it is reproduced anywhere in the frame.

MEASUREMENT CALLOUTS — this is a dimensioned hero photograph. Over the finished image, draw the measurements listed at the end of the PRODUCT block as flat technical annotations laid on top of the photograph, never as objects standing inside the scene. One callout per measurement, at most three: a hairline straight dimension line with a small tick or arrowhead at each end, spanning exactly the part of the product that measurement names, held just outside the product's silhouette in clear background, with its figure printed beside it in a small clean sans-serif. Print each figure exactly as the PRODUCT block states it — same digits, same unit — and never round, convert, recompute or invent one. Use a single neutral colour that separates from the background, near-black on a light scene and white on a dark one. The callouts never cross the product, never overlap one another, never touch the frame edge, and never sit over a pendant, stone, motif, dial, artwork or hardware. Drawing them changes nothing about the product, the pose, the scene or the crop.

These annotations are the only graphics and the only text permitted in the image, and this overrides the no-text rule in OUTPUT above. If the PRODUCT block says the scale was not legible, or carries no measurement sentence at all, draw no lines, no figures and no text whatsoever and output the clean photograph.`,
  },
]

const NECKLACE_DESCRIBE_BODY = `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the necklace; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

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
{"description":"<one factual 80-200 word paragraph>","presentation":"<necklace-pendant|necklace-station|necklace-multistrand|necklace-lariat|flat-curve>"}`

export const PROMPT_CATEGORY_CORES: readonly PromptCategoryCore[] = [
  {
    slug: 'necklace',
    label: 'Necklaces — draped',
    note: 'Close editorial macro: the pendant large and sharp, the chain draped on the scene surface with a soft shadow and leaving the top of the frame; never merges two necklaces into one.',
    describeBody: NECKLACE_DESCRIBE_BODY,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real jewellery at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then stage the piece close and draped as described below, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

CLOSE AND LARGE — THIS IS THE MOST IMPORTANT INSTRUCTION IN THIS BRIEF. This is an intimate macro still life, not a full-length catalogue shot. The pendant, or the central run of stations, is the hero and fills the frame: its width is roughly one quarter to one third of the frame width, so its engraving, facets, prongs and relief read at a glance. Only the lower portion of the necklace is in the picture. The whole piece is never shown; the camera is close enough that most of the chain is outside the frame. Never shrink the piece to fit the whole necklace in, never leave the pendant as a small object in a large empty field, and never let the chain become a thin faint line.

DRAPED ON THE SCENE — the necklace lies on the surface the scene names, styled by hand the way editorial jewellery is photographed: resting on it, in contact with it, casting a soft shadow onto it. The chain follows the surface's contours, drapes over a fold, a rim or a curve where the scene offers one, and settles into one relaxed, slightly asymmetric curve. Each chain arm runs from the pendant up and out of the frame, leaving through the TOP EDGE (or the top corners), so the piece reads as a neck-length necklace whose upper half simply continues outside the picture. The clasp, extender and terminal tag are outside the frame; they exist on the product but are not shown, and must never be invented inside the picture. The pendant sits in the lower half of the frame, hanging down from the chain, its bail or jump ring in contact with the chain exactly as built, with clean space beneath it. Read the centrepiece's real attachment from Image 1: a centrepiece fixed to the chain at BOTH ends lies horizontally between the two arms and is never re-hung from a single point or given an invented bail. No neck, bust, mannequin, model, stand, hook or hand appears anywhere.

THE CURVE — relaxed, not geometric. The two arms form a soft open U or a gently asymmetric V with easy slack in them; they are not pulled taut into straight lines, not arranged into a perfect circle, oval or loop, never folded back on themselves, never bunched into a pile, never crossed over each other. The chain reads link by link along its whole visible run.

HOW MANY NECKLACES — count the separate necklaces in Image 1 and render EXACTLY that many, as separate draped pieces. If there is one, centre its pendant. If there are two or more, lay them side by side or diagonally across the frame, evenly spaced, each one a complete curve of its own with its own pendant at its own lowest point. THEY MUST NOT TOUCH, CROSS, OVERLAP OR INTERLEAVE: keep clear surface between neighbouring chains along their whole visible length, including where they leave the frame — the arms of two necklaces exit at clearly separated points, never converging, and the gap between the two inner arms is at least as wide as a pendant. Never merge two necklaces into one chain or one shared loop. Every piece is rendered at its true size relative to the others.

FORM AND SCALE LOCK — reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone, ball or figaro link geometry as applicable, at the same link-size-to-pendant ratio, so many small links run along each arm. Never thicken links, lengthen them, or use fewer of them to fill the frame. Every pendant, station, charm and stone keeps its exact size relative to the chain. Rigid settings, pendants, motifs and connectors keep their real shape. Zoom only by moving the camera closer or uniformly scaling the whole piece; never enlarge a pendant or stone independently of the chain.

ART DIRECTION — the look of a premium minimalist jewellery brand's editorial product photography: warm, luminous, tactile and meticulously styled, while remaining a truthful photograph of this exact product. Polished gold reads as rich saturated gold with bright liquid highlights and warm dark reflections, never flat yellow, never pale or washed out. The pendant is the hero; the chain is its supporting line. A customer should feel she could reach in and pick it up.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} The necklace rests directly on that surface; it is the thing being photographed on it. Whatever the scene names as a surface — fabric, silk, marble, ceramic, stone, wood, satin — is what the chain lies across and the pendant rests on, and the chain casts one soft contact shadow onto it. Any prop the scene names beyond the surface stays in the background, out of focus, never touching or overlapping a pendant and never competing with the jewellery. Nothing else is in the frame.

CAMERA AND CROP — the low-distortion character of an 85-100mm macro lens at a close working distance, held at a slight downward angle of roughly 20-40 degrees, the way a stylist photographs a piece lying on a table, or straight on where the scene's surface is a vertical backdrop. Shallow depth of field: the pendant and the chain beside it are pin-sharp with crisp micro-detail; the chain softens gently as it runs away toward the top of the frame; the surface and any backdrop fall into creamy optical softness behind and beyond it. The piece spans most of the frame width where the arms leave the top. Never crop a pendant, and never crop a station on either arm below the point where the chain exits the frame.

LIGHTING — warm, directional, natural-looking daylight, placed as the scene above describes: one soft but clearly directional key from the upper side, as if from a window, gentle opposite fill, and a clean travelling highlight along the polished chain and pendant edges. The chain and pendant cast soft, slightly elongated shadows onto the surface they lie on, which gives the image depth and makes the metal feel solid and present. Existing faceted stones receive crisp controlled specular points and believable internal colour — clear stones read bright and colourless, never milky, grey or dull — without invented stones, glitter, starbursts, bloom or clipped highlights. The fine chain stays clearly visible against the surface along its whole visible run, including where it crosses the brightest or darkest part of the scene; hold the surface a shade lighter or darker than the metal so no link ever disappears.

COMMERCIAL RETOUCHING — remove any display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design.

FINAL IDENTITY CHECK — before output, verify the number of separate necklaces, strand count, chain construction, component ledger and sequence, every connection and mounting type, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm as well that the pendant is large in the frame and fully sharp, that the piece rests on the scene's surface with a soft contact shadow, that every chain arm leaves the top of the frame, that no two chains touch or cross, that each pendant is the lowest point of its own curve and is uncropped, and that no neck, bust, stand or hand has appeared.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no object beyond the surface and backdrop elements the scene paragraph itself names.`,
  },
  {
    slug: 'necklace-hanging',
    label: 'Necklaces — hanging',
    note: 'Straight-on gravity pose for drops, dangles, connector centrepieces and layered pieces: everything hangs vertical, tightly cropped, in front of the scene rather than on it.',
    describeBody: NECKLACE_DESCRIBE_BODY,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real jewellery at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then hang the piece as described below, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

HANGING, NOT LYING DOWN — THIS IS THE MOST IMPORTANT INSTRUCTION IN THIS BRIEF. The necklace is suspended in mid-air and photographed from the front, at the height of its centrepiece, the way it looks on a wearer's chest. It is NOT laid on a surface and NOT seen from above. There is no fabric, table or floor under it. Do not produce a flat-lay, a top-down view, a chain resting on satin, or a chain lying on anything. The camera looks horizontally at a piece hanging in front of a backdrop, and gravity is visibly in charge: every dangling part hangs straight down.

THE POSE — each necklace hangs as a relaxed narrow V or shallow U. Both chain arms rise from the centrepiece, diverge upward and outward, and run OFF THE TOP EDGE of the frame, where they are cut off. The clasp, extender and terminal tag are outside the frame; they exist on the product but are not shown, and must never be invented lower down. The centrepiece sits at the lowest point, in the lower half of the frame with clean space beneath it. Read the centrepiece's real attachment from Image 1 and keep it: a pendant on a bail hangs straight down under gravity; a Y-drop or lariat tail falls perfectly vertical with its end stone at the bottom; a row of dangling charms hangs with every charm pointing straight down from its own jump ring, evenly spaced, faces to the camera, none twisted, none touching; and a centrepiece fixed to the chain at BOTH ends lies horizontally between the two arms and is never re-hung from a single point. Nothing holds the piece up: no neck, bust, mannequin, model, stand, hook or hand appears anywhere.

CROP CLOSE — this is an intimate hero shot, not a full-length catalogue diagram. Frame the lower portion of the necklace only: a single pendant or drop reads large, roughly one fifth to one third of the frame width, pin-sharp in the lower half; a charm or station necklace fills the middle band of the frame with its charm-carrying run so every charm reads clearly. The arms leave the top edge just above the interesting region; most of the necklace is outside the picture. Never shrink the piece to fit all of it in, and never leave the centrepiece a small object in a large empty field.

HOW MANY — count the separate necklaces and strands in Image 1 and render EXACTLY that many. A layered piece with two strands hangs as two nested Vs, the shorter inside and above the longer, clearly separated at every point, the gap never smaller than the centrepiece, all four arms leaving the top edge at four clearly separated points. Two or more separate necklaces hang side by side, evenly spaced, each a complete V of its own. THEY MUST NOT TOUCH, CROSS, OVERLAP OR INTERLEAVE anywhere, including where they leave the frame. Never merge two chains into one, and hang each piece at its true length relative to the others.

IF THE SOURCE IS ALREADY HANGING — when Image 1 already shows the piece or pieces suspended with the chains leaving the top of the frame, KEEP that arrangement, spacing and height. Change only the scene, the lighting, the crop tightness, the cleanliness and the sharpness. Do not re-pose a photograph that is already correct.

FORM AND SCALE LOCK — keep the chain fine. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-centrepiece ratio, so many small links run down each arm; never swap it for a generic cable chain. Never thicken links, lengthen them, or use fewer of them to fill the frame. Every pendant, station, charm and stone keeps its exact size relative to the chain. Rigid settings, pendants, motifs and connectors keep their real shape. Zoom only by moving the camera or uniformly scaling the whole piece; never enlarge a pendant or stone independently.

ART DIRECTION — premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. The centrepiece is the hero and the chain is its supporting line. A customer should see at a glance how the piece will sit on her.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Take from that scene only its surfaces, palette, backdrop elements, light character and shadow behaviour. The necklace is never laid on any of it: any surface it names is a floor or backdrop standing BEHIND and BELOW the hanging piece, never something it rests on. Everything the scene places in the frame is backdrop only — clearly out of focus, never touching or overlapping the centrepiece, never competing with the jewellery. Nothing else is in the frame.

CAMERA AND CROP — the low-distortion character of an 85-100mm macro lens, held horizontally at centrepiece height, straight on. The centrepiece is completely sharp with crisp micro-detail; the chain stays sharp through the lower half and falls gently softer as it rises toward the top edge, which is what makes it read as hanging in space. The backdrop falls into creamy optical softness. Never crop the centrepiece, and never crop a charm or station on either arm below the point where the chain exits the frame.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a clearly directional key placed as the scene above describes, gentle opposite fill, and a restrained strip light that creates a clean travelling highlight along the polished chain and centrepiece edges. Natural warm-gold reflections rather than flat yellow metal. Every existing faceted stone shows a crisp specular point, a bright table and believable internal colour — clear stones read icy, bright and colourless, never milky, grey, dull or yellow-tinted — without invented stones, glitter, starbursts, bloom or clipped highlights. The piece hangs a short distance in front of the backdrop and casts one soft, slightly offset shadow of its chain and centrepiece onto it, which gives the frame depth and proves it is hanging rather than lying. The fine chain stays clearly visible against the background along its whole run, including where it crosses the brightest or darkest part of the scene.

COMMERCIAL RETOUCHING — remove any display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design.

FINAL IDENTITY CHECK — before output, verify the number of separate necklaces, strand count, chain construction, component ledger and sequence, every connection and mounting type, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm as well that every piece is hanging rather than lying down, that every chain leaves the top edge, that no two chains touch or cross, that every dangling part hangs vertically under gravity, that a both-ends centrepiece still spans the two arms, that the centrepiece is large in the frame and uncropped, and that no neck, bust, stand or hand has appeared.

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
  {
    slug: 'chain-bracelet',
    label: 'Chain bracelets',
    note: 'Holds 16-19 cm of chain at true wrist scale so a bracelet never renders as a necklace, and keeps the extender at its real gauge.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the chain bracelet; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

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
{"description":"<one factual 80-200 word paragraph>","presentation":"flat-arc"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real chain bracelet at its most flattering; improve only its presentation, never its design.

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

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the area immediately beneath and around the bracelet quiet and uncluttered, and confine any strong texture, fold, veining or pattern to the outer parts of the frame, softly out of focus so it reads as material rather than as pattern. Hold enough tonal separation from the metal that fine chain and the extender stay clearly visible. No hard line, prop or object beyond those the scene itself names, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, open/closed topology, strand count, chain construction, component ledger and sequence, all connection and mounting types, hardware count, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the result still reads as wrist size: a small relaxed circle or compact arc of clearly resolvable links, components large against the loop, the clasp and extender present at their true fraction and gauge, nothing that would pass for a necklace.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'anklet',
    label: 'Anklets',
    note: 'Guards ankle scale in both directions and refuses to invent a second anklet to complete a pair.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the anklet; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: its outline in the frame is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall shape it forms — no "laid out straight", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is an ankle-worn anklet. Name it as exactly that: never call it a bracelet or a necklace, and never hedge between categories — "anklet or bracelet" sends the posing stage hunting for the wrong scale.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; construction and topology, including strand count, chain type and link gauge, branches and connections; the length of the chain run stated as an approximate multiple of the largest component's width, and the extender's length as an approximate fraction of the main chain; whether a working closure is visible; a component ledger of the distinct charms, drops, bells, coins, tassels, stations, discs, motifs, beads and individually separated stones, ordered by their sequence ALONG THE STRAND starting from the clasp end and moving toward the far end, preserving irregular spacing and every asymmetry — and stating whether decoration runs the full length or occupies one decorated run with plainer chain elsewhere; each component's shape, colour, cut, relative size and mounting method; and clasp, extender and terminal-tag count and type.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- The two length proportions are required even when a count is withheld. They are what stops the next stage rendering an ankle-length chain as a wrist bracelet or a necklace, and they are the most valuable facts in this record. If the paragraph is running long, drop finish adjectives before dropping them.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- State the item quantity plainly. One anklet is one anklet: never describe a single piece as a pair, and never assume an unseen matching partner exists.
- Distinguish a drilled, dangling or jump-ring-mounted charm from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones. Report faint, colourless and clear stones as carefully as coloured ones.
- Preserve side-specific order and every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

The presentation class is fixed for this inspection: a flexible ankle chain is flat-arc. Never return a necklace class — those mean neck length — and never angled-band, which means a rigid bangle or kada.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"flat-arc"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real anklet at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then pose the piece at its true ankle size, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: open or closed topology, branches and connection points; strand count; chain-link construction and gauge; exact component count, order, side placement and relative spacing; stone, charm, motif and pendant shapes, colours, cuts, relief and mounting methods; clasp, extender, end caps and terminal tags; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted charm from a prong- or bezel-set element. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

TRUE SIZE — THIS IS AN ANKLE-WORN ANKLET AND MUST READ AS ONE, never as a wrist bracelet and never as a necklace. It carries roughly 22-27 cm of chain plus a short extender: once round an adult ankle, noticeably longer than a wrist bracelet, far shorter than a necklace. Fastened, it forms a generous circle about the width of a spread palm. An anklet can be corrupted in both directions, so three proportions are mandatory.
- LINKS. The chain goes round in a clearly longer run than a bracelet's, yet every link stays individually resolvable at the hero crop. Hold the photographed link gauge exactly: never coarsen or shorten the chain — that shrinks the piece into a bracelet — and never render the links finer or more numerous — that stretches it into a necklace. The link gauge is the scale witness.
- RATIO. Every charm, drop, bell, disc and stone keeps its true size against the whole chain run. On an anklet the decorative components read distinctly smaller against the loop than they would on a bracelet, yet each one remains clearly legible; resizing a component against its chain is what shifts the piece into the wrong category.
- EXTENDER. An anklet's extender is about a fifth to a quarter of the main chain, its links one readable step larger than the main run. Reproduce the photographed extender at exactly that relative length and link size: never let it swell into a heavy feature chain, and never trim it to a token tail. The clasp and extender stay fully visible inside the frame.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A stylist may bend and drape only genuinely flexible chain; rigid settings, pendants, motifs, bands and connectors keep their real shape. Reproduce the photographed chain itself, including flat curb, cable, box, snake, rope, wheat, herringbone or figaro link geometry as applicable, at the same link-size-to-component ratio. Keep every pendant, charm, motif and stone at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, pendant or decorative run independently. Keep every component naturally aligned with its real attachment.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. Its accidental outline, the direction the piece happens to lie, and anything overlapping it are facts about that one snapshot, not about the product. Re-pose the piece properly for retail; never reproduce the arrangement it was dumped in, and never infer the product's length from how loosely or tightly it was laid out for that shot.

POSE — lay the anklet flat and take the arrangement from what Image 1 shows. CLOSURE VISIBLE: fasten the two real ends using only that hardware into one relaxed, softly rounded circle with natural slack — an easy organic round, never a taut geometric ring and never a wide flattened oval — with the clasp and its extender lying together naturally along the upper part of the curve. GENUINELY OPEN, OR NO CLOSURE VISIBLE: lay the piece at full length in one relaxed compact arc or soft S; invent no clasp. Throughout, the chain settles under its own weight in smooth relaxed curves: no taut runs, no measuring-tape layout, no bunching the piece smaller to fit.

DANGLES — many anklets carry drops, bells, coins, tassels or charms along the run, and they are the design. Every dangling element stays on its real attachment in its exact count, order, side placement and spacing, each settling outward from the fastened circle under its own weight — none flipped, stacked, tangled or crossed over the chain. If the source concentrates its decoration along one front run with plainer chain behind, keep exactly that distribution; never redistribute dangles evenly around the loop, and never continue a decorated run further than the source carries it. Bells and coins keep their real size and count; a tassel hangs as one gathered drop, outward or inward exactly as its attachment dictates.

HOW MANY — count the separate anklets in Image 1 and render EXACTLY that many. One anklet sits centred — and one means one: never add a second anklet to complete a pair, mirror the piece, or echo it in the background. Two or more lie side by side, evenly spaced, each posed completely with its own closure state; they must not touch, cross, overlap or share a chain, and no piece is ever duplicated, mirrored or merged into another.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that fine gold chain does not disappear. It must read immediately as a desirable storefront hero at mobile size — and immediately as a piece worn at the ankle — not as a flat inventory record or technical diagram.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, near-overhead, optionally with a restrained 5-15 degree rake to reveal genuine relief. Focus-stack the complete jewellery design so links, connections, settings, dangles, clasp and extender are crisp. Let the posed anklet fill roughly 80-90% of the useful square with breathing room in the corners. The complete piece stays inside the frame: never crop a charm, drop, bell, station, junction, clasp, extender, end cap, terminal tag or distinctive fitting, and never push chain off an edge — an anklet fits its frame whole, and showing it whole is part of what reads as ankle size.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the centre beneath the jewellery quiet and nearly smooth, and confine any strong fold, veining, texture or pattern toward the outer edges, softly out of focus so it reads as luxurious material rather than as pattern. Hold enough tonal separation from the metal that fine chain, small bells and the extender stay clearly visible. No hard line, prop or object beyond those the scene itself names, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, open/closed topology, strand count, chain construction, component ledger and sequence, all connection and mounting types, hardware count, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the result still reads as ankle size: a generous relaxed circle of individually resolvable links, components legible but modest against the loop, the clasp and extender present at their true fraction and gauge, every dangle on its real attachment, exactly the source's number of anklets, nothing that would pass for a bracelet or a necklace.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'hand-chain',
    label: 'Hand chains',
    note: 'Anchors the piece to a real hand — wrist section and finger loops must encircle, and a worn source keeps its fit.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority. Produce a factual identity record of ONLY the hand-chain jewellery; ignore the display card, packaging, hand, skin, surface, shadows, labels and any hardware that is not physically part of the product.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; the wrist section and its closure; exact number of chains or branches crossing the hand and every junction; exact number and construction of finger loops or rings; exact strand count, chain type and gauge; a component ledger with the exact visible count and connection order of charms, motifs, beads and individually separated stones; every component's shape, colour, cut and mounting method; exact clasp, extender and terminal-tag count and type; and relative sizes, spacing and proportions.

Rules:
- Describe the object, not the photograph. Never state how the piece happens to be lying or what overall outline it forms in the frame — no "laid in a rough square", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "top edge", "down the left side", "upper right", "at the bottom centre". That arrangement is re-posed later, and reporting it corrupts the posing stage that reads this record.
- Order components by their sequence along the product itself, starting from a named fixed point such as the clasp end, and never by position in the frame.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or something is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it.
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- Apply the two-count rule above to all visible sections, branches, loops, junctions, fittings and discrete design elements. Do not use "several", "multiple" or "scattered" in place of a count. Do not count ordinary chain links or fabricate a count for continuous pavé.
- State exactly what attaches to the wrist section, what crosses the hand, and what attaches to each finger loop. Preserve every asymmetry.
- Distinguish drilled, dangling and jump-ring-mounted charms from prong, bezel or glued settings, and solid-metal motifs from gemstones.
- If partly obscured, say so and report only visible facts. Never infer hidden components, materials or gemstone species.
- No claims about beauty, quality, luxury or value. Do not describe the hand pose, skin, background, packaging, lighting or photography.

Choose the closest presentation class from: pair-upright, flat-curve, standing-three-quarter, angled-band, flat-arc, tray-grid. The image preset stages the product on a hand, so this class is recorded but not injected into the image prompt.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"<pair-upright|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference, into the exact same hand chain worn naturally on one hand. Photograph the real jewellery at its most flattering; improve only its presentation and fit, never its design.

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

SCENE AND BACKGROUND — one relaxed adult hand and forearm, resting in the scene described here. {{SETTING_DETAIL}} Take from that scene only its surfaces, palette, backdrop elements, light character and shadow behaviour: everything it names lies behind and beneath the hand, never on it, never touching the jewellery, and no prop supports the hand. Keep the field behind the hand quiet and softly out of focus so it reads as luxurious material rather than as pattern. Natural skin texture with neat natural nails, no nail art, no rings or unrelated jewellery, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add soft, diffused contact shadows where the jewellery rests on skin so it feels physically worn.

COMMERCIAL RETOUCHING — remove the display card, packaging, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. Skin stays photorealistic with natural texture and even tone; the jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the wrist-section, branch, junction, strand, finger-loop, component and hardware counts, the chain construction, every connection and mounting type, asymmetry and relative scale against Image 1, and confirm the hand shows five natural fingers with correct anatomy. Confirm as well that the wrist section actually encircles the wrist at the wrist crease, that every loop encircles the base of its finger, that the branch count over the back of the hand matches Image 1 exactly, and that any tassel or drop hangs free rather than lying along the skin. Correct the presentation rather than changing any of those facts.

OUTPUT — one opaque, photorealistic square premium retail image showing exactly one hand. No second hand, face, mannequin, text, watermarks, borders, halos, extra or missing fingers, warped anatomy, malformed metal or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'bag',
    label: 'Bags and pouches',
    note: 'Stands the bag up in its real resting form and reproduces artwork, lettering and hardware exactly.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority. Produce a factual identity record of ONLY the bag or pouch; ignore packaging, hands, surfaces, shadows, price tags and anything not physically part of the product.

Inspect the image closely before answering. In one paragraph, cover in this order: exact item quantity; product type; exact silhouette and whether it is rigid, semi-structured or soft; material, weave or grain, colour and finish; exact panel, pocket and compartment layout visible in the source; exact closure count and type; exact handle and strap count, construction and attachment points; exact hardware count, shapes and metal colours; stitching, seams, piping and trim; and any artwork or lettering. Transcribe lettering only when fully legible, with exact spelling, capitalisation, colour and placement.

Rules:
- Describe the object, not the photograph. Never state how the piece happens to be lying or what overall outline it forms in the frame — no "laid in a rough square", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "top edge", "down the left side", "upper right", "at the bottom centre". That arrangement is re-posed later, and reporting it corrupts the posing stage that reads this record.
- Order components by their sequence along the product itself, starting from a named fixed point such as the clasp end, and never by position in the frame.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or something is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it.
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- Apply the two-count rule above to visible pockets, closures, handles, straps, attachments and hardware. Preserve asymmetry and natural softness; do not describe an idealised, taut or more structured version.
- If a feature is partly obscured, say so and report only visible facts. Never invent an unseen side, pocket, gusset, lining, material or word. If lettering is uncertain, describe it as illegible rather than guessing.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, hand, lighting or photography.

Return presentation "standing-three-quarter". The bag preset stages the product itself, so this class is recorded but not injected into the image prompt.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"standing-three-quarter"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference, into the exact same bag or pouch. Photograph the real product at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then choose a truthful angle and form, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: silhouette, structure and proportions; material texture, weave, grain or pile; panel, gusset and pocket layout; closure count and type; handle and strap count, length and attachment points; hardware shape, finish and count; stitching, seams, piping, trim, artwork, lettering, colours and every visible asymmetry. Reproduce lettering and artwork exactly as photographed — never translate, restyle, correct or re-space it. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

FORM AND STRUCTURE LOCK — retain the product's real construction and believable resting geometry. A soft bag stays softly shaped and may settle naturally under its own weight; a structured bag keeps its exact structure. Do not inflate, stretch, taper, flatten, stiffen or slim the silhouette, and never invent an unseen side, base or lining. Keep every pocket, pull, buckle and decorative element at its exact relative size. Zoom only by moving the camera or uniformly scaling the entire photographed product; never enlarge hardware or artwork independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. Its accidental outline, the direction the piece happens to lie, and anything overlapping it are facts about that one snapshot, not about the product. Re-pose the piece properly for retail; never reproduce the arrangement it was dumped in.

ART DIRECTION — recover the selling power of premium accessory campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful negative space and enough contrast that material texture and hardware read clearly. It must look like a desirable storefront hero at mobile size, not a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm product lens with no wide-angle stretch. Choose the angle from the real construction: near-front for a flat pouch, a gentle three-quarter view only when genuine depth is visible in the source. Focus-stack the product so weave, stitching, hardware and lettering are crisp. Fill roughly 78-88% of the useful square with clean breathing room, and never crop a handle, strap, closure, logo or distinctive fitting.

STANDING AND PRESENTATION — present the bag upright and self-supporting in its natural resting form, with handles or straps arranged deliberately rather than dropped at random: standing softly, laid where the construction demands it, or with one strap draped to reveal its real attachment. No hidden supports, stands or props may appear in frame.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, it is supporting texture and never a competing pattern: keep any veining, fold, grain or shadow edge well away from artwork, lettering and the product's own edges, and let the far surface fall into gentle creamy optical softness. Hold enough tonal separation from the material that the silhouette and its hardware stay clearly readable. No prop, riser or object beyond those the scene itself names, and nothing touching, propping up or overlapping the product beyond the surface it rests on.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that separates the silhouette from the background. Render material honestly — matte stays matte, grain stays grain, patent stays glossy — with controlled highlights on hardware and no artificial sheen on fabric. Add one light, diffused contact shadow directly beneath and slightly behind the product so it feels physically grounded.

COMMERCIAL RETOUCHING — remove packaging, hands, price labels, tags, stickers, dust, lint and unrelated branding. Preserve real texture, seams, stitching, piping, artwork, relief and exact lettering. Clean and refine edges and micro-contrast without turning the material into smooth plastic, CGI or an upgraded product. The bag stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the silhouette and proportions, panel, pocket, gusset and closure counts, handle and strap count and attachment points, hardware count, artwork, exact lettering and spelling, colours, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, warped lettering, invented hardware or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'earrings',
    label: 'Earrings',
    note: 'Never invents a missing second earring, keeps the pair a true mirror, and reproduces the post or hook exactly.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the earrings; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The pieces were laid down casually for one snapshot: how they happen to face, lean or overlap is an accident of that moment and will be re-posed later by a photographer. Never state how they happen to be lying or what overall shape they form — no "laid side by side", "one on top of the other", "angled apart". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

These are ear-worn earrings. Name them as exactly that, and name the fitting: never call an earring a pendant, charm or brooch, and never hedge between categories.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity, stated as one earring or two; metal colour and finish; the fitting on each earring — post and back, screw back, French or shepherd hook, lever back, huggie hinge, clip, hoop closure or threader — and its length and gauge; the overall drop length stated as an approximate multiple of the widest part; construction and articulation, including how many separate sections hang from one another and where they hinge; a component ledger of the distinct stones, pearls, motifs, discs, tassels and dangles, ordered from the fitting downward, with each one's shape, colour, cut, relative size and mounting method; and every visible difference between the two earrings.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- State the item quantity plainly. One earring is one earring: never describe a single piece as a pair, and never assume an unseen matching partner exists.
- The fitting type and the drop proportion are required even when a count is withheld. They are what stops the next stage rendering a hook as a stud or a shoulder-duster as a small drop.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not fabricate a count for a continuous pavé field.
- When two earrings are present, describe them as one design and then state every real difference between them. Do not describe an idealised, perfectly identical pair.
- Distinguish a drilled, dangling or jump-ring-mounted element from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones. Report faint, colourless and clear stones as carefully as coloured ones.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the pieces rest on.

The presentation class is fixed for this inspection: earrings are pair-upright. Never return flat-arc or flat-curve — those mean a flexible chain — and never angled-band, which means a rigid bangle or kada.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"pair-upright"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real earrings at their most flattering; improve only their presentation, never their design.

PRIORITY ORDER — first preserve product identity and the number of earrings, then stand them upright at their true ear size, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: earring count; fitting type and construction; the number of hinged or articulated sections and where each one joins; strand and chain construction and gauge where the design carries any; exact component count, order and relative spacing on each earring; stone, pearl, motif, disc and tassel shapes, colours, cuts, relief and mounting methods; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a dangling or jump-ring-mounted element from a prong- or bezel-set one. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

HOW MANY EARRINGS — count the separate earrings in Image 1 and render EXACTLY that many. TWO means a pair, side by side. ONE MEANS ONE: never add a second earring to complete the pair, never mirror the photographed earring into a partner, and never echo it softly in the background. A fabricated partner is stock that does not exist, and this catalogue sells single pieces. More than two are laid out in one even row or grid, evenly spaced, never touching or overlapping.

PAIR SYMMETRY — when Image 1 genuinely shows two earrings, they are one design seen twice, and each is rendered from its own half of the source. They face the camera as a MIRRORED pair — fittings at the same height, drops at the same length, decorative faces turned the same way — and they are never a single earring copied and pasted twice. Any real difference the source shows between the two, such as a shorter drop, a differently oriented stone or a missing back, is a fact about the product and stays exactly as photographed.

FITTING CONSTRUCTION IS EXACT — the fitting is what a customer buys by name, so it is reproduced precisely: a straight post with or without its butterfly back, a screw back, a French or shepherd hook, a lever back, a huggie hinge, a clip, a hoop closure or a threader. Keep its real length, wire gauge, curve and angle relative to the body of the earring. Never convert one fitting type into another, never add a back the source does not show, never straighten a hook or close an open hoop, and never tuck the fitting behind the earring where it cannot be seen — the fitting stays fully visible and uncropped.

TRUE SIZE — THESE ARE EAR-WORN EARRINGS AND MUST READ AS ONE. A stud reads as a small piece sitting flat against a lobe; a drop or chandelier reads as hanging clear below it. Hold the photographed proportion between the fitting and the body of the earring exactly: enlarging a stone or a drop against its own post is what turns a stud into a pendant, and thickening a hook is what turns a delicate earring into costume hardware. Every stone, pearl, motif and dangle keeps its true size against the whole earring.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. Rigid settings, motifs, hoops, bands and connectors keep their real shape; only genuinely flexible chain or tassel may settle. Keep every component naturally aligned with its real attachment, and keep articulated sections hanging in the order and at the spacing the source shows. Zoom only by moving the camera or uniformly scaling the entire photographed pair; never enlarge a focal stone, drop or fitting independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The direction each earring happens to face, the way they overlap, and anything lying across them are facts about that one snapshot, not about the product. Re-pose them properly for retail; never reproduce the arrangement they were dumped in.

POSE — stand the earrings upright on the surface, facing the camera front-on, in one clean symmetrical arrangement. Two earrings sit side by side with a small clear gap between them, both fittings uppermost and at the same height, decorative faces turned squarely to the lens, and every drop, tassel or articulated section falling straight down under its own weight in a relaxed line. A single earring stands centred in exactly the same attitude. Nothing supports them in view: no stand, hook, clip, card or hidden prop appears anywhere, and the earrings never overlap, lean on one another, or tangle their chains.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that a fine hook or thin wire does not disappear. It must read immediately as a desirable storefront hero at mobile size, not as a flat inventory record or technical diagram.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, held level with the earrings and straight on, optionally with a restrained 5-15 degree elevation to reveal genuine relief. Focus-stack the complete design so the fitting, every setting, every hinge and every stone are crisp. Let the pair fill roughly 70-85% of the useful square with breathing room in the corners. The complete piece stays inside the frame: never crop a post, back, hook, hinge, drop, tassel tip or distinctive fitting.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the area immediately behind and beneath the earrings quiet and uncluttered so the silhouette of each drop reads cleanly, and confine any strong fold, veining, texture or pattern toward the outer parts of the frame, softly out of focus. Hold enough tonal separation from the metal that a fine hook or wire stays clearly visible against it. No prop, riser, stand or object beyond those the scene itself names, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath each earring so the pair feels physically grounded and equally lit.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the earring count, the fitting type on each earring, the number and order of articulated sections, the component ledger, every mounting type, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that no second earring has been invented to complete a pair, that a genuine pair reads as a mirrored pair rather than one earring duplicated, that every fitting is present, unaltered and uncropped, and that nothing props the earrings up in frame.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, ears, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'rings',
    label: 'Rings',
    note: 'Holds band profile, stone count and cut at macro scale, and never adds a finger the source does not show.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the ring or rings; ignore display cards, trays, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: how it happens to face or lean is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall shape the group forms — no "laid flat", "lying on its side", "arranged in rows". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is a finger-worn ring. Name it as exactly that: never call it a bangle, a charm or a pendant, and never hedge between categories.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; the band — its profile as flat, rounded, knife-edge, twisted, split, stacked or open, its width stated as an approximate fraction of the head's width, and whether it is a closed circle, an adjustable open band or a wrap; the head or top of the ring, its silhouette and relief; a component ledger of the individually separated stones, pearls and motifs with each one's shape, cut, colour, relative size and setting method — prong, bezel, channel, pavé, flush or glued; whether any shoulder, gallery or inner-band detail is visible; and every engraving, texture and visible asymmetry.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- The band-width proportion is required even when a count is withheld. It is what stops the next stage rendering a fine band as a heavy signet.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a stone is too small, faint or obscured to resolve, describe the stones and their arrangement WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not fabricate a count for a continuous pavé field; describe its extent and density instead.
- State the item quantity plainly. When the source is a tray, card or box of separate rings, say so and give the number of rings only if every one is clearly resolvable and both counts agree.
- Give the cut of each separately visible stone. Never upgrade a cut, a setting or a stone: describe a clear faceted element as exactly that when the material is uncertain, and distinguish a solid-metal motif from a gemstone.
- Preserve every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

Choose exactly one presentation class: standing-three-quarter for one ring or a small group of loose rings; tray-grid when Image 1 shows a tray, card or box holding many separate rings. Never choose flat-arc, flat-curve or angled-band: those mean a flexible chain or a rigid bangle.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"<standing-three-quarter|tray-grid>"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real ring at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then stand the ring at true finger size, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: ring count; band profile, width and topology, including whether the band is a closed circle, an adjustable open band, a split, twisted or stacked band, or a wrap; head silhouette and relief; exact stone count, arrangement, cut and setting method; shoulder, gallery and inner-band detail; engraving and texture; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone, and a prong, bezel, channel, flush or pavé setting from one another. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

BAND PROFILE IS EXACT — the band is the part the customer wears, and its cross-section is the design. Reproduce the photographed profile exactly, whether flat, rounded, knife-edge, tapered, twisted, split, stacked or open, at its true width relative to the head of the ring. Never widen a fine band into a heavy one, never round a flat band, never close an adjustable open band into a full circle, and never taper a band the source keeps at an even width. If the source shows a gap, keep the gap at exactly its photographed size.

STONE COUNT AND CUT ARE EXACT — render the stones that are physically present, in their photographed number, arrangement, relative sizes and settings. Never add a stone to balance the design, never remove a small accent, never regularise irregular spacing, and never upgrade a cut or a setting: a flat-cut or cabochon stone stays flat, a claw-set stone keeps its claws, a glued or flush stone never grows prongs, and a solid-metal motif never becomes a gemstone. A continuous pavé field keeps its real extent and density rather than being extended around the band.

MACRO SCALE — THIS IS A FINGER-WORN RING AND MUST READ AS ONE. It is a small object shot large: the inner opening is about the width of an adult finger, and everything else is judged against it. Hold the photographed ratio between band width, head size and stone size exactly — enlarging a centre stone against its own band is what turns a modest ring into a cocktail piece, and thickening the band is what turns it into a bangle. The whole ring is rendered at genuine macro sharpness, with the metal's real surface texture, tool marks and relief visible rather than smoothed into a render.

NO FINGER UNLESS THE SOURCE IS WORN — if Image 1 shows the ring loose, on a card, in a tray or in a hand held only to display it, the final photograph shows the ring alone with no hand, no finger and no skin anywhere in the frame. Only when Image 1 shows the ring genuinely worn on a finger may a hand appear, and then it keeps the same finger, the same orientation and the same seating on that finger, with the retail hand relaxed, the nails neat and natural, and no other jewellery in frame.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A ring is rigid: it keeps its exact circle, its exact head geometry and its exact relief, and nothing about it bends or drapes. Keep every stone and motif naturally aligned with its real setting. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, head or decorative run independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The direction the ring happens to face, the way it leans, and anything lying across it are facts about that one snapshot, not about the product. Re-pose it properly for retail; never reproduce the arrangement it was dumped in.

POSE — stand the ring upright on the surface in a hero three-quarter attitude: the band resting on its lower edge, the head turned toward the camera and tipped slightly back so both the face of the head and the profile of the band are readable at once, and the inner opening reading clearly as a circle rather than as a flat disc. Nothing supports it in view — no stand, riser, wedge, clip or hidden prop appears anywhere. TWO OR MORE LOOSE RINGS: stand each one in the same attitude, evenly spaced in a single clean row, not touching, overlapping or leaning on one another. A TRAY, CARD OR BOX OF SEPARATE RINGS: keep the tray and reproduce every visible slot and every ring in it, in its real grid order and count, none added, removed, duplicated or rearranged.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that the band's profile and the stone's facets both read. It must look immediately like a desirable storefront hero at mobile size, not a flat inventory record or a technical diagram.

CAMERA AND CROP — use the natural low-distortion character of a 90-105mm macro product lens, held close to the height of the ring, with a restrained downward rake of 10-20 degrees so the head and the band are both revealed. Focus-stack the complete design so the band edges, the gallery, every prong and every facet are crisp front to back. Let the ring fill roughly 65-80% of the useful square with clean breathing room, and never crop the band, the head, a shoulder or a distinctive fitting.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the immediate area under and behind the ring quiet so the circle of the band reads cleanly against it, and confine any strong veining, fold or pattern to the outer parts of the frame, softly out of focus. Hold enough tonal separation from the metal that the band's profile stays visible where it crosses the brightest and darkest parts of the scene. No prop, riser, stand or object beyond those the scene itself names, and nothing touching, propping up or overlapping the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along the band's polished edge. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define the curve of the band. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath the ring so it feels physically grounded rather than floating.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the ring count, band profile and width, band topology including any adjustable gap, head silhouette and relief, stone count, cuts and settings, engraving, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the band has not been widened or closed, that no stone has been added, removed or upgraded, that the ring stands unsupported with nothing propping it up, and that no hand, finger or skin appears unless Image 1 itself showed the ring worn.

OUTPUT — one opaque, photorealistic square premium retail image. No people, mannequins, text, watermarks, borders, halos, malformed metal or duplicated components; no hand, finger or skin unless the source showed the ring worn; and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'kada-bracelet',
    label: 'Kada bracelets',
    note: 'Treats the bangle as rigid: true circumference, the exact opening or hinge, and engraving preserved.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the kada or bangle; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: how it happens to face or lean is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall outline it forms — no "lying flat", "standing on edge", "tilted away". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is a rigid wrist-worn kada or bangle. Name it as exactly that: never call it a chain bracelet or an anklet, and never hedge between a rigid and a flexible piece — that sends the posing stage hunting for the wrong shape entirely.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; the band — its width and thickness stated as approximate fractions of the bangle's outer diameter, its cross-section as flat, rounded, half-round, square, twisted or tapered, and whether that width is even all the way round or swells toward a broader face; the closure — a fully closed circle, a hinged opening with a clasp or a box catch, a screw or push fitting, or an open cuff with a gap, stating the gap width relative to the band; the terminals or end caps and their shapes; a component ledger of the stones, motifs, studs and applied elements with each one's shape, colour, cut, relative size and mounting method, ordered around the band from the closure; and every engraved, cast, carved, antiqued or textured pattern, described by what it depicts and how far around the band it runs.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- The band-width proportion and the closure type are required even when a count is withheld. They are what stops the next stage rendering a broad kada as a thin bangle, or a hinged piece as a solid closed circle.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not fabricate a count for a continuous pavé field or a repeating engraved motif; state its extent and density instead.
- Report engraving and relief as a pattern the metal carries, never as decoration that could be simplified away. Say plainly whether it runs the whole circumference or only part of it.
- Distinguish a prong, bezel, channel, flush or glued setting from one another, and a solid-metal motif from a gemstone.
- Preserve every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

The presentation class is fixed for this inspection: a rigid kada, bangle or cuff is angled-band. Never return flat-arc or flat-curve — those mean a flexible chain bracelet, anklet or necklace.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"angled-band"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real kada at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then stand the bangle at its true wrist circumference, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: bangle count; band width, thickness and cross-section; whether the band is even all the way round or swells toward a broader face; closure type and topology; terminal and end-cap shapes; exact stone, stud, motif and applied-element count, order, side placement and relative spacing; setting methods; every engraved, cast, carved or antiqued pattern and how far around the band it runs; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a prong, bezel, channel or flush setting from one another. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

RIGID, NOT FLEXIBLE — A KADA IS A SOLID BAND AND MUST READ AS ONE. It does not drape, coil, sag, bend, twist out of round or lie in an arc. It holds one continuous rigid circle — or, where the source is an open cuff, one rigid C — and every part of it keeps that geometry under any pose. Never render it as a chain, never let its outline slump into an oval where the source is round, and never allow a highlight or shadow to suggest a joint the metal does not have.

TRUE CIRCUMFERENCE — THIS IS A WRIST-WORN KADA AND MUST READ AS ONE, never as a finger ring and never as an anklet. Its inner opening is sized to pass over an adult hand and sit on the wrist: roughly the width of a spread palm across. Two proportions carry that reading and both are mandatory.
- BAND AGAINST OPENING. Hold the photographed ratio between band width and inner opening exactly. Widening the band against the opening shrinks the piece toward a ring; narrowing it stretches the piece into an oversized hoop.
- DECORATION AGAINST BAND. Every stone, stud, motif and engraved element keeps its true size against the band it sits on. Enlarging a centre motif against its own band is the single change that makes a kada read as a cuff two sizes larger.

OPENING AND HINGE ARE EXACT — reproduce the closure the source actually has and nothing else. A fully closed circle stays closed with no invented hinge, clasp or seam. A hinged bangle keeps its hinge and its catch at exactly the photographed positions, shown in the state the source shows them. A screw, push-button or box catch keeps its real mechanism and its real proportions. An open cuff keeps its gap at exactly the photographed width and its terminals at exactly the photographed spacing — never closed up to tidy the silhouette, never sprung wider to fill the frame. Never invent a clasp on a piece that has none, and never remove one it does have.

ENGRAVING AND RELIEF ARE PRESERVED — carved, cast, antiqued, hammered, filigree and textured work is the design, not surface noise. Reproduce the photographed pattern in the same depth, sharpness, orientation and coverage, running exactly as far around the band as the source carries it and no further. Never smooth relief into polished metal, never regularise a hand-worked pattern into a machine repeat, never continue a partial pattern the whole way round, and never darken or brighten antiquing beyond what the source shows.

FORM AND SCALE LOCK — retain the product's real construction. Rigid settings, motifs, bands, terminals and connectors keep their real shape and relative size. Keep every component naturally aligned with its real attachment. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a focal stone, terminal or decorative run independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The direction the bangle happens to face, the way it leans, and anything lying across it are facts about that one snapshot, not about the product. Re-pose it properly for retail; never reproduce the arrangement it was dumped in.

POSE — stand the kada upright on the surface as an angled band: resting on its lower edge, the plane of the circle tilted back roughly 25-40 degrees from vertical so the inner opening reads clearly as an ellipse and the band's width and cross-section are both visible, with the most decorated face or the closure turned toward the camera exactly as the construction warrants. Nothing supports it in view — no stand, riser, wedge, clip or hidden prop appears anywhere. TWO OR MORE BANGLES: stand each one in the same attitude, evenly spaced in one clean row, not touching, overlapping, stacking or leaning on one another, and never nested one inside the other unless the source shows them joined.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that engraved relief reads as depth rather than as flat pattern. It must look immediately like a desirable storefront hero at mobile size, not a flat inventory record or a technical diagram.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, held near the height of the bangle with a restrained downward rake so the ellipse of the opening and the outer face are both revealed. Focus-stack the complete design so engraving, terminals, settings and the closure are crisp from front edge to back. Let the kada fill roughly 70-85% of the useful square with clean breathing room, and never crop the band, a terminal, a hinge, a catch or a distinctive fitting.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the area inside and immediately around the bangle quiet so the opening reads as open space and the outer silhouette stays clean, and confine any strong veining, fold or pattern to the outer parts of the frame, softly out of focus. Hold enough tonal separation from the metal that the band's edges stay readable. No prop, riser, stand or object beyond those the scene itself names, and nothing touching, propping up or overlapping the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along the band's polished edge. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define the curve of the band and let engraved relief cast its own micro-shadows. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath the bangle so it feels physically grounded rather than floating.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the bangle count, band width, thickness and cross-section, the closure type and its exact state, terminal shapes, the component ledger and sequence, every setting type, the engraved pattern and its coverage, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the piece still reads as a rigid wrist-sized band: one solid circle or C of its true circumference, decoration modest against the band, the opening or hinge exactly as photographed, engraving intact and unsmoothed, nothing that would pass for a flexible chain bracelet.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, hands, mannequins, text, watermarks, borders, halos, malformed metal, invented hinges or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'nose-pin',
    label: 'Nose pins',
    note: 'Millimetre-scale guard: the piece must read as a few millimetres wide, with its stud or wire reproduced exactly.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the nose pin; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: how it happens to face or lean is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall outline it forms — no "lying flat", "pin pointing sideways", "set at an angle". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is a nose pin, and it is a very small object. Name it as exactly that: never call it an earring, a stud earring, a charm or a pendant, and never hedge between categories — the wrong category name sends the posing stage hunting for a piece ten times this size.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; the fitting — a straight post with a screw or push back, an L-bent post, a curved or corkscrew wire, a hinged clicker hoop, a plain hoop, or a pressure-fit pin — and its length and wire gauge stated relative to the decorative head; the head itself, its silhouette, diameter and relief; a component ledger of the individually separated stones and motifs with each one's shape, cut, colour, relative size and setting method; any surrounding halo, cluster or filigree work; and every visible asymmetry.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- Always state the head's size in relation to the post or wire. That proportion is the only scale reference the next stage has, and without it a three-millimetre stud is rendered as a pendant.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a stone is too small, faint or obscured to resolve, describe the stones and their arrangement WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not fabricate a count for a continuous pavé field.
- State the item quantity plainly. One nose pin is one nose pin: never describe a single piece as a pair, and never assume an unseen matching partner exists. When the source is a card or tray of separate pins, say so.
- Name the fitting exactly. A screw post, a push post, a bent L-post, a curved wire and a clicker hoop are different products, and the fitting is what a buyer chooses by.
- Distinguish a prong, bezel, flush or glued setting from one another, and a solid-metal motif from a gemstone. Report faint, colourless and clear stones as carefully as coloured ones.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

Choose exactly one presentation class: standing-three-quarter for a single nose pin; pair-upright when the source genuinely shows two matched pins; tray-grid when the source is a card, tray or box of separate pins. Never choose flat-arc, flat-curve or angled-band: those mean a flexible chain or a rigid bangle.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"<standing-three-quarter|pair-upright|tray-grid>"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real nose pin at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, then hold the piece at its true millimetre scale, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: nose-pin count; fitting type, length, wire gauge and bend; head silhouette, diameter and relief; exact stone and motif count, arrangement, cut and setting method; halo, cluster and filigree detail; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif from a stone and a prong, bezel, flush or glued setting from one another. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

TRUE SIZE — THIS IS A NOSE PIN AND MUST READ AS A FEW MILLIMETRES ACROSS. It is the smallest thing this catalogue sells: the decorative head is typically two to six millimetres wide and the post is a fine wire, thinner than the head is broad. It is photographed large, but it must never look large. Three proportions carry that reading and all three are mandatory.
- HEAD AGAINST POST. Hold the photographed ratio between the head and the length and gauge of its post or wire exactly. Growing the head against its own post is the single change that turns a nose pin into a pendant or a stud earring.
- STONE AGAINST HEAD. Every stone, accent and motif keeps its true size against the head. On a piece this small a single stone often IS the head; never enlarge an accent stone until it rivals the centre.
- MACRO EVIDENCE. Because the piece is tiny and shot close, the photograph must show the evidence of that: real metal micro-texture, the faint tool marks of a small setting, the slightly soft edge of a fine wire, and depth of field shallow enough that a millimetre of distance is visible. A nose pin rendered with the smooth, flawless surfaces of a large object reads as a large object.

FITTING CONSTRUCTION IS EXACT — the fitting is what a customer buys by name, so reproduce precisely what is photographed: a straight post with a screw or push back, an L-bent post, a curved or corkscrew wire, a hinged clicker hoop, a plain hoop, or a pressure-fit pin. Keep its real length, wire gauge, curve, bend angle and any threading. Never convert one fitting into another, never straighten a curved wire or curl a straight post, never add a back the source does not show, and never hide the fitting behind the head — the whole fitting stays visible and uncropped, because it is half the product.

FORM AND SCALE LOCK — retain the product's real construction. The head and its settings are rigid and keep their exact geometry; only a genuinely flexible element may settle. Keep every stone and motif naturally aligned with its real setting. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge the head, a stone or the fitting independently of one another.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The direction the pin happens to point, the way it leans, and anything lying across it are facts about that one snapshot, not about the product. Re-pose it properly for retail; never reproduce the arrangement it was dumped in.

POSE — stand the nose pin on the surface in a hero three-quarter attitude: the decorative head turned squarely toward the camera and tipped very slightly back, the post or wire angled down and away so its full length, gauge and bend are readable, and the piece resting naturally rather than balanced on a point. Nothing supports it in view — no stand, block, clip, wax, card or hidden prop appears anywhere. TWO MATCHED PINS: stand them side by side as a mirrored pair with a small clear gap, both heads at the same height. A CARD, TRAY OR BOX OF SEPARATE PINS: keep it and reproduce every visible slot and every pin in its real grid order and count, none added, removed, duplicated or rearranged.

HOW MANY — count the separate nose pins in Image 1 and render EXACTLY that many. One pin sits centred, and one means one: never add a second pin to complete a pair, never mirror the piece, and never echo it in the background.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy and generous negative space around a very small object, with enough contrast that a fine wire does not disappear. It must look immediately like a desirable storefront hero at mobile size — and immediately like a piece worn on the nose — not a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of a 90-105mm true macro product lens at close working distance, held near the height of the piece with a restrained downward rake. Focus-stack the head, every setting and the full length of the post so all are crisp, while the surface falls away quickly with the shallow depth of field that genuine macro brings. Let the nose pin fill roughly 45-65% of the useful square — deliberately less than a larger piece would, because the surrounding space is what tells a buyer how small this is — and never crop the head, the post, the wire, a bend or a back.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the immediate area around this very small object completely quiet and read its texture at the piece's own scale: any grain, weave, veining or fold near the pin must stay finer than the piece itself, or it will make the pin look bigger than it is. Confine stronger pattern to the outer parts of the frame, softly out of focus. Hold enough tonal separation from the metal that a fine wire stays clearly visible. No prop, riser, stand or object beyond those the scene itself names, and nothing touching, propping up or overlapping the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along the polished head and the length of the wire. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form. Existing faceted stones receive crisp controlled specular points and believable internal colour from the lights, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath the piece, small and tight in keeping with its size, so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the nose-pin count, the fitting type, length, gauge and bend, the head silhouette and diameter, the stone count, cuts and settings, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the result still reads as a piece a few millimetres across: the head modest against its own post, macro depth of field and real metal micro-texture visible, generous empty space around it, the complete fitting shown and uncropped, nothing that would pass for a stud earring or a pendant.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, noses, faces, mannequins, hands, text, watermarks, borders, halos, malformed metal or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'watch',
    label: 'Watches',
    note: 'Dial markings, hand positions and brand text stay exactly as photographed, and strap links stay countable.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the watch; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The watch was laid down casually for one snapshot: how the strap happens to fall or curl is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall outline it forms — no "laid out straight", "strap curled round", "buckle folded under". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is a wrist watch. Name it as exactly that, and never hedge between a watch and a bracelet even when the strap is a metal chain.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish of the case and of the strap; the case — its shape as round, square, rectangular, tonneau or other, its diameter relative to the strap width, its profile, bezel and crown position; the dial — its colour, texture and finish, the exact style of its hour markers as numerals, batons, dots or a mix, whether a date or sub-dial window is present and where it sits on the dial face, and the exact position of the hour, minute and second hands read as a clock time; any brand or model LETTERING on the dial, transcribed exactly, with its spelling, capitalisation and placement, only when it is fully legible; the strap or bracelet — its construction as links, mesh, leather, fabric or bangle, the link shape and how many rows run across its width, its taper, and its closure as a folding clasp, buckle, hook or slip-on; and every stone, engraving, texture and visible asymmetry.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- The hand positions and the marker style are required. They are the two things a viewer checks first, and an invented time or an invented numeral is the most visible possible error.
- Transcribe dial lettering only when every character is legible. If it is not, say the dial carries illegible lettering and where it sits. A wrong brand name is worse than none.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a marker or link is too small, faint or obscured to resolve, describe them and their arrangement WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not fabricate a count for a continuous pavé field.
- Describe the strap's link geometry and row count rather than counting every link along its length.
- Distinguish a prong, bezel, channel or flush setting from one another, and a solid-metal motif from a gemstone.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or movement.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

The presentation class is fixed for this inspection: a watch on its strap is angled-band. Never return flat-arc or flat-curve — those mean a flexible chain bracelet, anklet or necklace.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"angled-band"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real watch at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, above all the dial, then stand the watch at its true wrist size, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: watch count; case shape, diameter, profile, bezel and crown position; dial colour, texture and finish; hour-marker style, count and placement; hand shapes and their exact positions; date or sub-dial window and its position on the dial; all dial lettering; strap or bracelet construction, link geometry, row count, taper and closure type; stone, engraving and applied-element count and setting; metal colour, finish, proportions and every visible asymmetry. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

THE DIAL IS THE PRODUCT — REPRODUCE IT EXACTLY. Every marking on the dial is a fact, and a dial that has been redrawn is a different watch.
- HANDS. The hour, minute and second hands stay in EXACTLY the positions Image 1 shows, at their photographed lengths and shapes. Never move them to a more attractive time, never straighten or lengthen one, never add a second hand the source does not have, and never remove one it does.
- MARKERS. Reproduce the marker style, count and spacing precisely — numerals stay numerals in the same typeface and orientation, batons stay batons, dots stay dots, and a dial with markers only at some hours keeps exactly those and no others. Never fill in missing markers, never convert one style into another, never renumber.
- LETTERING. Brand and model text is reproduced exactly as photographed: same words, same spelling, same capitalisation, same placement, same size and same weight. Never translate, restyle, re-space, correct, sharpen into a different typeface or invent a brand name. If lettering is illegible in the source, keep it illegible rather than resolving it into words.
- WINDOWS. A date or sub-dial window keeps its exact position, shape, size and displayed content. Never add a date window, never move one, never change the number showing in it.

STRAP LINKS STAY COUNTABLE — reproduce the strap the source actually has, at its real link geometry, row count and taper, so an individual link stays resolvable along the whole visible run. Never smooth a linked bracelet into a continuous band, never merge rows, never re-proportion the links so the strap can sweep further across the square, and never replace one construction with another — mesh stays mesh, leather keeps its grain and stitching, a bangle stays rigid. The clasp, buckle, keeper and any end pieces stay fully visible and exactly as photographed.

TRUE SIZE — THIS IS A WRIST WATCH AND MUST READ AS ONE. Hold the photographed ratio between case diameter and strap width exactly: enlarging the case against its own strap is what turns a slim dress watch into an oversized sports piece, and thinning the strap does the same. Fastened, the strap forms a circle scarcely wider than a palm.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. The case, bezel, crown and clasp are rigid and keep their exact shape; only a genuinely flexible strap may curve. Keep every applied element naturally aligned with its real attachment. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge the case, the dial or a decorative run independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The way the strap happens to fall, the direction the case happens to face, and anything lying across it are facts about that one snapshot, not about the product. Re-pose it properly for retail; never reproduce the arrangement it was dumped in.

POSE — fasten the strap with its own real closure and stand the watch upright as a clasped ellipse: the strap forming one relaxed rounded loop resting on its lower edge, the plane of that loop tilted back roughly 25-40 degrees from vertical, and the case riding at the top of the curve turned squarely toward the camera so the entire dial is readable front-on without foreshortening. The clasp sits at the lower back of the loop. Where the source shows no working closure, lay the strap in one relaxed open curve instead and invent no clasp. Nothing supports the watch in view — no stand, cushion, riser, block or hidden prop appears anywhere. TWO OR MORE WATCHES: stand each in the same attitude, evenly spaced in one clean row, not touching, overlapping or leaning on one another.

ART DIRECTION — recover the selling power of premium watch campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. The dial is the hero and the strap is its supporting line. Create one confident composition with a clear focal hierarchy and enough contrast that the markers and hands read cleanly against the dial. It must look immediately like a desirable storefront hero at mobile size, not a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, held level with the case and straight on to the dial, so the dial is seen square rather than raked. Focus-stack the complete design so the dial printing, the hands, the bezel, the crown and the strap links are crisp from front to back. Let the watch fill roughly 70-85% of the useful square with clean breathing room, and never crop the case, the crown, the clasp, a lug or a distinctive fitting. Any reflection on the crystal stays controlled and never covers a marker, a hand or the lettering.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the area behind the case quiet so the dial reads cleanly, and confine any strong veining, fold or pattern to the outer parts of the frame, softly out of focus. Nothing bright, patterned or hard-edged may reflect in the crystal or the polished case in a way that obscures a marker, a hand or the dial lettering. Hold enough tonal separation from the metal that the strap's links stay readable. No prop, riser, stand, cushion or object beyond those the scene itself names, and nothing touching, propping up or overlapping the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along the case and the polished links. Produce natural warm-gold or neutral steel reflections rather than flat metal, with realistic dark reflection channels that define curved form. Keep the crystal free of blown highlights: the dial stays fully legible, and existing stones receive crisp controlled specular points without invented sparkle, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath the watch so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, price tags, stickers, protective film, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, brushed and polished areas, relief, dial printing and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The watch stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the watch count, case shape and proportions, bezel and crown position, dial colour and texture, marker style, count and placement, the exact hand positions, the date or sub-dial window and its contents, every character of the dial lettering including its spelling and capitalisation, the strap construction, link geometry and row count, the closure type, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the time shown is the time Image 1 shows, that no marker or window has been added or removed, that the links remain individually countable, and that no reflection hides part of the dial.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, wrists, mannequins, hands, added text, watermarks, borders, halos, warped or invented dial lettering, invented date windows, malformed metal or duplicated components, and no prop, box, stand, cushion or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'indian-jewellery',
    label: 'Indian pendant sets',
    note: 'Shows the set together as a set, keeps kundan and meena work intact, and never merges the pieces into one.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the jewellery set; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The set was laid down casually for one snapshot: how the pieces happen to sit relative to one another is an accident of that moment and will be re-arranged later by a photographer. Never state how anything happens to be lying or what overall outline the group forms — no "laid in a triangle", "earrings beside the pendant", "chain looped round". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is an Indian pendant set. Say plainly how many separate pieces it contains and what each one is — pendant, chain, earrings, tikka, ring or any other component — because the photograph must show every one of them and nothing more.

Inspect the image closely before answering. In one paragraph, cover in this order: the exact number of separate pieces and what each one is; metal colour and finish; for the pendant, its silhouette, relief and construction; for the earrings, their fitting type and whether they match the pendant's motif; for the chain, its link type and gauge and its length as an approximate multiple of the pendant's width; the traditional work present, named exactly — uncut kundan stones in their gold-foil bezels, coloured meena enamel and which colours it uses, jadau setting, polki, filigree, granulation, temple work or antiqued oxidised finish — and where on each piece that work sits; a component ledger of the individually separated stones, pearls, beads and hanging drops with each one's shape, colour, cut, relative size and mounting method; and every visible asymmetry.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- The piece count is the single most important fact in this record. Give it plainly and early. Never describe a set as one object, and never assume a piece that is not visible exists because sets usually include one.
- Name the traditional work by its own name when it is clearly identifiable, and describe it factually when it is not. Kundan, meena and jadau are construction facts, not decoration that can be simplified.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a stone or drop is too small, faint or obscured to resolve, describe the components and their arrangement WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- Distinguish a drilled, dangling or jump-ring-mounted element from a prong, bezel, foil-backed kundan or glued setting. Distinguish solid-metal motifs and enamel fields from gemstones.
- Preserve every visible asymmetry and every difference between the two earrings. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the pieces rest on.

The presentation class is fixed for this inspection: a set of several separate pieces is tray-grid. Never return flat-arc or angled-band — those mean a single flexible bracelet or a rigid bangle.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"tray-grid"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real jewellery set at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity and the number of separate pieces, then arrange the whole set legibly in one frame, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical items and quantity: the number of separate pieces and what each one is; pendant silhouette, relief and construction; earring fitting type and construction; chain link construction, gauge and length; exact stone, pearl, bead and drop count, order, side placement and relative spacing on every piece; kundan, meena, jadau, polki, filigree, granulation and antiquing exactly where the source carries them; setting and mounting methods; metal colour, finish, proportions and every visible asymmetry. Distinguish a solid-metal motif and an enamel field from a gemstone, and a foil-backed kundan bezel from a prong or claw setting. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

A SET IS SHOWN AS A SET — count the separate pieces in Image 1 and render EXACTLY that many, all of them together in one frame, all completely visible. If the source is a pendant with a chain and a pair of earrings, the photograph shows a pendant, a chain and two earrings. Never drop a piece because the composition is easier without it, never add a piece because sets usually include one — no invented tikka, no invented ring, no second pair of earrings — and never show only the pendant.

NEVER MERGE THE PIECES — every piece stays physically separate, with clear background between it and its neighbours along its whole outline. An earring never fuses into the pendant, a pendant motif never grows earring drops, the chain never passes through or behind another piece, and no piece is duplicated, mirrored or blended into another. Where the pendant and earrings share a motif, they remain three separate objects that repeat one design; that shared motif is exactly why merging is the failure this set will fall into if it is going to.

TRADITIONAL WORK IS PRESERVED — kundan, meena, jadau, polki, filigree, granulation, temple work and oxidised antiquing are the construction of this jewellery, not surface decoration.
- KUNDAN. Every uncut stone keeps its own irregular outline and its surrounding hand-pushed gold-foil bezel, at its photographed size and position. Never regularise the outlines into faceted round stones, never replace the foil bezel with claws, never smooth the slightly uneven metal frame that surrounds each stone.
- MEENA. Enamel keeps its exact colours, its exact fields and its exact boundaries against the metal, with the same glossy depth. Never recolour it, never extend a field, never let it bleed over a wire that contains it.
- RELIEF AND ANTIQUING. Carved, cast, granulated and oxidised work keeps its real depth, sharpness and coverage, running exactly as far as the source carries it. Never polish antiquing out of a recess, never brighten oxidised metal into plain gold, never regularise hand-worked repetition into a machine pattern.

FORM AND SCALE LOCK — retain each piece's real construction and believable resting geometry. A stylist may drape only genuinely flexible chain; rigid settings, pendants, motifs, plaques and connectors keep their real shape. Reproduce the photographed chain at the same link-size-to-pendant ratio, and hold the true relative sizes BETWEEN the pieces — the earrings stay at their real size against the pendant, and neither grows to balance the composition. Zoom only by moving the camera or uniformly scaling the entire photographed set; never enlarge a focal stone, pendant or piece independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The way the pieces happen to sit, the direction each faces, and anything overlapping them are facts about that one snapshot, not about the product. Re-arrange them properly for retail; never reproduce the arrangement they were dumped in.

POSE — lay the complete set out flat and near-symmetrically, as a jeweller presents it. The pendant sits centred and face-up with its chain arranged behind and around it in one relaxed, smooth curve — the clasp gathered neatly, the chain never crossing over the pendant or over an earring. The earrings sit one to each side of the pendant, mirrored, at the same height and the same distance from the centre, face-up and squarely to the camera, with their drops falling naturally outward or downward under their own weight. Any further piece is placed on the same axis in its own clear space. Every piece keeps a visible margin of background around it, and none of them touch, cross or overlap.

ART DIRECTION — recover the selling power of premium jewellery campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact set. Create one confident composition with a clear focal hierarchy — the pendant leads, the earrings answer it, the chain carries the eye — with graceful use of negative space and enough contrast that kundan foil, enamel colour and antiqued recesses all read. It must look immediately like a desirable storefront hero at mobile size, not a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, near-overhead and square to the layout, optionally with a restrained 5-15 degree rake to reveal genuine relief. Focus-stack the complete set so every stone, every enamel field, the earring fittings and the chain links are crisp across the whole arrangement. Let the set fill roughly 80-90% of the useful square with breathing room in the corners. Every piece stays whole inside the frame: never crop a pendant, an earring, a fitting, a drop, a clasp or a distinctive fitting, and never push chain off an edge.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the whole area the set occupies quiet and even, so several separate pieces read as one clean arrangement rather than as clutter, and confine any strong fold, veining, texture or pattern toward the outer parts of the frame, softly out of focus. Hold enough tonal separation from the metal that fine chain stays visible and that the enamel colours are not swamped by the background's own colour. No prop, riser, stand or object beyond those the scene itself names, and nothing touching, crossing or visually competing with the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Produce natural warm-gold reflections rather than flat yellow metal, with realistic dark reflection channels that define curved form and let antiquing keep its depth. Kundan stones show their characteristic soft foil-backed glow rather than the hard fire of a faceted gem, and meena enamel keeps its glossy saturated colour. Existing faceted stones receive crisp controlled specular points, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow beneath each piece so the set feels physically grounded and evenly lit.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real engraving, texture, antiquing, brushed areas, relief, prongs, bezels, enamel and plating colour. Clean and refine edges and micro-contrast without turning the metal into smooth plastic, CGI or an upgraded design. The jewellery stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the number of separate pieces and what each one is, the pendant silhouette and relief, the earring fittings, the chain construction and length, the component ledger and sequence on every piece, all mounting types, the kundan bezels, the meena fields and colours, the antiquing coverage, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that every piece the source shows is present and whole, that no piece has been invented, that no two pieces touch, overlap or have merged into one object, and that no traditional work has been polished, recoloured or regularised away.

OUTPUT — one opaque, photorealistic square premium retail image. No people, skin, mannequins, hands, text, watermarks, borders, halos, malformed metal, invented pieces or duplicated components, and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
  {
    slug: 'hair-accessory',
    label: 'Hair accessories',
    note: 'Reproduces the mechanism — clip, band or pin — exactly, and shows the piece worn only when the source is worn.',
    describeBody: `You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the hair accessory; ignore display cards, packaging, hands, hair, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: how it happens to face, curl or lean is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall outline it forms — no "laid flat", "opened out", "curved round". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

This is a hair accessory. Name the exact type and, above all, name its MECHANISM: a rigid hairband or alice band, a soft covered band, an elastic scrunchie, an alligator or crocodile clip, a snap or tic-tac clip, a claw or jaw clip, a barrette with a bar-and-catch, a banana clip, a U-pin, a bobby pin, a hair stick, a comb or a tiara. Never hedge between mechanisms — a clip and a band are different products and the photograph must show the right one.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; the mechanism, named exactly, and how it works — the hinge, spring, catch, teeth, prongs or elastic that holds it, whether it is open or closed in the source, and how many teeth or prongs are visible; the body of the piece, its shape, width and length, and whether it is rigid or flexible; the material and finish of the body, whether metal, resin, acetate, fabric-covered, beaded or pearl-set, and its colour; the decorative work — stones, pearls, flowers, bows, motifs — with each element's shape, colour, relative size and how it is mounted; and every visible asymmetry.

Rules:
- 60 to 100 words. One paragraph. No headings or bullet points inside the description.
- The mechanism is the single most important fact in this record. Give it plainly, and never substitute a general word such as "clip" when the source clearly shows a claw, a barrette or a snap.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or an element is too small, faint or obscured to resolve, describe the elements and their arrangement WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not fabricate a count for a continuous beaded or pavé field.
- State the item quantity plainly. One clip is one clip: never describe a single piece as a pair or a set, and never assume an unseen matching partner exists.
- Distinguish a glued, sewn, wire-wrapped, prong-set and bezel-set element from one another, and a solid motif from a gemstone.
- Preserve every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or mechanism.
- No claims about beauty, quality, luxury or value. Do not describe hair, a model, the background, packaging, lighting, photography or the surface the piece rests on.

Choose exactly one presentation class: angled-band for a rigid hairband, alice band, tiara or comb; standing-three-quarter for a clip, barrette, pin, stick or scrunchie; tray-grid when the source is a card, tray or box of separate pieces. Never choose flat-arc or flat-curve: those mean a flexible chain bracelet, anklet or necklace.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 60-100 word paragraph>","presentation":"<angled-band|standing-three-quarter|tray-grid>"}`,
    imageBody: `Create one persuasive luxury e-commerce hero photograph by editing Image 1, the supplied product reference. Photograph the real hair accessory at its most flattering; improve only its presentation, never its design.

PRIORITY ORDER — first preserve product identity, above all its mechanism, then stand the piece so that mechanism is legible, then apply the scene and photographic polish. If styling conflicts with product fidelity, product fidelity wins.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SOURCE AUTHORITY — NON-NEGOTIABLE. Image 1 is the sole visual authority; the PRODUCT record is a factual inspection aid. Preserve the exact same physical item and quantity: item count; mechanism type and construction, including its hinge, spring, catch, teeth, prongs, comb or elastic and their exact number; body shape, width, length and whether it is rigid or flexible; material and finish; exact stone, pearl, bead, flower, bow and motif count, order, side placement and relative spacing; mounting methods; colour, proportions and every visible asymmetry. Distinguish a solid motif from a gemstone, and a glued, sewn, wire-wrapped or prong-set element from one another. If the text conflicts with the visible source, follow Image 1. If a detail is obscured, preserve the visible ambiguity rather than inventing it.

THE MECHANISM IS THE PRODUCT — REPRODUCE IT EXACTLY. A hair accessory is bought by how it fastens, and swapping the mechanism ships the wrong product.
- TYPE. Render exactly the mechanism Image 1 shows — a rigid hairband or alice band, a soft covered band, an elastic scrunchie, an alligator or crocodile clip, a snap or tic-tac clip, a claw or jaw clip, a barrette with its bar-and-catch, a banana clip, a U-pin, a bobby pin, a hair stick, a comb or a tiara. Never convert one into another, never turn a clip into a band, never turn a band into a headwrap.
- PARTS AND COUNTS. Every tooth, prong, hinge pin, spring, catch and comb tine is reproduced in its photographed number, size and spacing. Never add teeth to fill a gap, never remove one, never regularise uneven spacing, and never smooth a visible spring or hinge away because it is not decorative — it is the part that works.
- STATE. Show the mechanism in the state the source shows it: a clip photographed closed stays closed, one photographed open stays open at the same angle. Never close a piece so its underside disappears, and never spring a closed piece open.
- VISIBILITY. The mechanism stays visible and uncropped in the final frame. A hair accessory photographed with its fastening hidden is a photograph a buyer cannot use.

TRUE SIZE — this piece is worn on a head and must read at that scale: a band arcs wide enough to pass over the crown, a claw clip is about the length of a palm, a bobby pin is a slim wire a finger long. Hold the photographed ratio between the decorative elements and the body of the piece exactly — enlarging a flower or a stone against its own band is what turns a wearable accessory into a costume prop.

WORN ONLY IF THE SOURCE IS WORN — if Image 1 shows the piece loose, on a card, in a tray or held only to display it, the final photograph shows the accessory alone, with no head, no hair, no face and no skin anywhere in the frame. Only when Image 1 shows the piece genuinely worn in hair may hair appear, and then it keeps the same placement, the same orientation and the same section of hair the source shows, with everything else in the frame changed only for scene, lighting, cleanliness and sharpness.

FORM AND SCALE LOCK — retain the product's real construction and believable resting geometry. A rigid band or comb keeps its exact arc and cannot be flexed flatter or rounder to suit the frame; a soft band, elastic or ribbon may settle naturally under its own weight but keeps its real length and gathering. Keep every decorative element naturally aligned with its real attachment. Zoom only by moving the camera or uniformly scaling the entire photographed piece; never enlarge a motif, stone or fitting independently.

SOURCE POSE IS NOT THE PRODUCT — the reference photograph is a quick reference shot taken on whatever surface was available. The direction the piece happens to face, the way it leans, and anything lying across it are facts about that one snapshot, not about the product. Re-pose it properly for retail; never reproduce the arrangement it was dumped in.

POSE — stand the piece upright on the surface so both its decorated face and its mechanism are readable at once. A RIGID BAND, COMB OR TIARA: rest it on its two ends as an angled band, the plane of its arc tilted back roughly 25-40 degrees from vertical so the curve reads as a curve and the decorated outer face turns toward the camera, with the teeth or inner edge visible below. A CLIP, BARRETTE, CLAW OR PIN: stand it on its lower edge in a three-quarter attitude, decorated face toward the camera and tipped slightly back, with the hinge, spring or catch turned just far enough into view to be identified. A SCRUNCHIE OR SOFT BAND: let it settle into its natural relaxed ring on the surface without being stretched, flattened or folded. Nothing supports the piece in view — no stand, block, riser, clip or hidden prop appears anywhere. TWO OR MORE PIECES: stand each in the same attitude, evenly spaced in one clean row, not touching, overlapping or leaning on one another.

ART DIRECTION — recover the selling power of premium accessory campaign photography: elegant, luminous, dimensional and meticulously styled, while remaining a truthful photograph of this exact product. Create one confident composition with a clear focal hierarchy, graceful use of negative space and enough contrast that both the decorative face and the working mechanism read clearly. It must look immediately like a desirable storefront hero at mobile size, not a flat inventory record.

CAMERA AND CROP — use the natural low-distortion character of an 85-100mm macro product lens, held near the height of the piece with a restrained downward rake so the face and the fastening are both revealed. Focus-stack the complete design so the decorative elements, the hinge, the teeth and the catch are crisp from front to back. Let the accessory fill roughly 70-85% of the useful square with clean breathing room, and never crop a tooth, a prong, a hinge, a catch, an end of a band or a distinctive fitting.

SCENE AND BACKGROUND — {{SETTING_DETAIL}} Whatever that scene provides, keep the area immediately around and beneath the piece quiet so its silhouette and the fine teeth of its mechanism read cleanly, and confine any strong fold, veining, texture or pattern toward the outer parts of the frame, softly out of focus. Hold enough tonal separation from the material that a slim wire, a thin band or a fine tooth stays clearly visible. No prop, riser, stand or object beyond those the scene itself names, and nothing touching, propping up or overlapping the product.

LIGHTING — warm luxury studio lighting with accurate neutral colour: a large diffused key placed as the scene above describes, gentle opposite fill, and a restrained strip or rim light that creates a clean travelling highlight along polished edges. Render material honestly — matte resin stays matte, acetate keeps its depth, fabric keeps its weave, metal keeps its real reflections — with controlled highlights and no artificial sheen. Existing stones and pearls receive crisp controlled specular points and believable surface lustre, without invented stones, glitter, starbursts, bloom or clipped highlights. Add one light, diffused contact shadow directly beneath the piece so it feels physically grounded.

COMMERCIAL RETOUCHING — remove the display card, packaging, hands, hair, tags, stickers, clips, dust, lint, fingerprints and unrelated branding. Preserve real texture, engraving, relief, stitching, weave, prongs, bezels and plating colour. Clean and refine edges and micro-contrast without turning the material into smooth plastic, CGI or an upgraded design. The accessory stays completely sharp while the background falls away gently into creamy optical softness.

FINAL IDENTITY CHECK — before output, verify the item count, the mechanism type and every part of it, the tooth, prong and hinge counts, the open or closed state, the body shape and proportions, the decorative ledger and its mounting types, asymmetry and relative scale against Image 1. Correct the presentation rather than changing any of those facts. Confirm too that the mechanism is the one the source shows and is fully visible and uncropped, that no tooth or prong has been added or removed, and that no head, hair, face or skin appears unless Image 1 itself showed the piece worn.

OUTPUT — one opaque, photorealistic square premium retail image. No people, faces, mannequins, hands, text, watermarks, borders, halos, malformed hardware or duplicated components; no head, hair or skin unless the source showed the piece worn; and no prop, box, stand or object beyond those the scene paragraph itself names.`,
  },
]

export function categoryCore(slug: string): PromptCategoryCore | null {
  return PROMPT_CATEGORY_CORES.find((core) => core.slug === slug) ?? null
}

export function promptSetting(slug: string): PromptSetting | null {
  return PROMPT_SETTINGS.find((setting) => setting.slug === slug) ?? null
}

export function promptMeasurement(slug: string): PromptMeasurement | null {
  return PROMPT_MEASUREMENTS.find((measurement) => measurement.slug === slug) ?? null
}

/** bestFor matches first, in declaration order, then everything else. */
export function settingsForCategory(
  categorySlug: string,
): readonly PromptSetting[] {
  // The hanging necklace core flatters the same scenes as the draped one.
  const key = categorySlug === 'necklace-hanging' ? 'necklace' : categorySlug
  return [
    ...PROMPT_SETTINGS.filter((setting) => setting.bestFor.includes(key)),
    ...PROMPT_SETTINGS.filter((setting) => !setting.bestFor.includes(key)),
  ]
}

/**
 * Pure composition of a category x setting x measurement triple — the exact
 * bodies "Use for new batches" materialises. Client-safe (this file has no
 * imports), so the prompts screen can preview what a combination produces
 * before anything is written; the server's ensure-pair reuses it as the single
 * source of truth.
 *
 * An unmeasured pair keeps the two-part slug it has always had, so every pair
 * already stored stays the same row and nothing is re-materialised.
 */
export function composeClientPair(
  categorySlug: string,
  settingSlug: string,
  measurementSlug: string = 'plain',
): {
  readonly slug: string
  readonly label: string
  readonly describeBody: string
  readonly imageBody: string
} | null {
  const core = categoryCore(categorySlug)
  const setting = promptSetting(settingSlug)
  const measurement = promptMeasurement(measurementSlug)
  if (!core || !setting || !measurement) return null

  const measured = measurement.describeRule !== '' || measurement.imageRule !== ''
  let describeBody = core.describeBody
  if (measurement.describeRule) {
    // Ahead of the JSON contract, so the last thing the describer reads is
    // still the output format it must obey.
    const jsonContract = 'Return ONLY raw JSON'
    if (!describeBody.includes(jsonContract)) return null
    describeBody = describeBody.replace(
      jsonContract,
      `${measurement.describeRule}\n\n${jsonContract}`,
    )
  }

  return {
    slug: measured ? `${categorySlug}--${settingSlug}--${measurementSlug}` : `${categorySlug}--${settingSlug}`,
    label: measured
      ? `${core.label} · ${setting.label} · measured`
      : `${core.label} · ${setting.label}`,
    describeBody,
    imageBody:
      core.imageBody.replace('{{SETTING_DETAIL}}', setting.scene) +
      (measurement.imageRule ? `\n\n${measurement.imageRule}` : ''),
  }
}
