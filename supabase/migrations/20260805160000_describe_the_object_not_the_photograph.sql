-- Two new prompt versions, both non-current. Promote deliberately in /prompts.
--
-- 1. DESCRIBE — stop the photograph's transient layout leaking into the product
--    record.
--
-- Observed 2026-08-05 on the screw-motif necklace (IMG20260805144043). The
-- describer wrote "laid as a loose loop", "along the top edge from the left",
-- "down the left side", "at the lower right", "the upper-left is partly
-- obscured by a finger" — and on a second necklace, "laid open in a rough
-- square". None of that is product identity; it is how the piece happened to be
-- dumped on a desk for one phone snap.
--
-- That text is injected into the image prompt as the PRODUCT record, where it
-- contradicts PRODUCT-SPECIFIC POSE. The generated image duly reproduced the
-- desk layout: a lumpy rounded rectangle with a flat top and an awkward
-- three-station cluster in one corner, instead of the clean oval the previous
-- run produced. The old prompt banned describing "the background, packaging,
-- lighting or photography" but never the piece's arrangement in frame.
--
-- Counting is also relaxed deliberately. The old rule made exact counts
-- mandatory, so an uncertain describer emitted a confident wrong number — it
-- said eleven stations where there are ten. The image model resolved that
-- conflict differently on two consecutive runs: once it followed the
-- photograph and rendered ten, once it followed the text and invented an
-- eleventh. A wrong count is therefore strictly worse than no count, because
-- with no number the model falls back on the source image, which is right.
--
-- 2. IMAGE — a short, aesthetic-led alternative in the shape the owner gets
--    from the ChatGPT web interface (~190 words against the current 774).
--
-- Round-one evidence (docs/PROGRESS.md, 2026-08-05) already showed a 237-word
-- camera-and-light prompt produced the best photograph of five variants, and
-- that its weakness — chain substitution — is fixed by naming link geometry
-- explicitly. This keeps that finding and drops the compliance bulk.

do $migration$
declare
  v_actor constant text := 'migration:20260805160000';

  v_describe constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority for WHAT THE PRODUCT IS. Produce a factual identity record of ONLY the jewellery; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Describe the object, not the photograph. The piece was laid down casually for one snapshot: its outline in the frame is an accident of that moment and will be re-posed later by a photographer. Never state how it happens to be lying or what overall shape it forms — no "laid in a rough square", "a loose loop", "an open circle", "a shallow V". Never locate anything by where it sits in the picture — no "at the top centre", "along the top edge", "down the left side", "upper right", "at the bottom". Reporting the accidental pose corrupts the posing stage that reads this record.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; construction and topology, including strand count, chain type and gauge, branches and connections; a component ledger of the distinct pendants, charms, motifs, stations, beads and individually separated stones, ordered by their sequence ALONG THE STRAND starting from the clasp end and moving toward the far end, preserving irregular spacing and every asymmetry; each component's shape, colour, cut, relative size and mounting method; central feature silhouette and relief; clasp, extender and terminal-tag count and type; and relative proportions.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- Count each component type twice before answering. Give an exact count only when both counts agree and every instance is clearly resolvable. If they disagree, or a component is too small, faint or obscured to resolve, describe the components and their order WITHOUT a total. A confident wrong count is worse than no count: with no number the image stage follows the photograph, which is correct.
- Never replace a resolvable count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- Distinguish a drilled, dangling or jump-ring-mounted charm from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones. Report faint, colourless and clear stones as carefully as coloured ones; a clear stone in a metal bezel is easy to miss and must not be omitted.
- Preserve side-specific order and every visible asymmetry. Do not describe an idealised or symmetrical version.
- If part of the product is obscured, say only that it is partly obscured and report what is visible. Never name or describe what obscures it. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting, photography or the surface the piece rests on.

Choose exactly one presentation class:
pair-upright for a matched pair; necklace-pendant for a necklace with one dominant pendant or central drop; necklace-station for a single-strand necklace with spaced fixed or dangling decorative stations and no dominant pendant; necklace-multistrand for two or more joined parallel strands; necklace-lariat for an open Y-shaped necklace with a junction and drop; flat-curve only for another flexible long chain that fits none of those four necklace classes; standing-three-quarter for a ring; angled-band for a kada, bangle, cuff or rigid bracelet; flat-arc for a flexible bracelet or anklet; tray-grid for multiple separate items on one tray or card.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"<pair-upright|necklace-pendant|necklace-station|necklace-multistrand|necklace-lariat|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>"}$describe$;

  v_image constant text := $image$Luxury jewellery e-commerce hero photograph of this exact piece, styled and shot by a professional product photographer.

PRODUCT
{{PRODUCT_DESCRIPTION}}

LOOK — soft pearl-ivory satin background, warm luxury lighting, shallow depth of field with the background beautifully blurred, ultra-sharp product with crisp detail, natural gold reflections, controlled sparkle on stones that are already there, soft believable shadows, high resolution, square 1:1, and a consistent aesthetic across every product.

POSE
{{COMPOSITION_DETAIL}}

SAME PIECE — the reference photograph is the authority for what this product is. Reproduce its chain construction and link geometry as photographed, matching flat curb, cable, box, snake, rope, wheat, herringbone or figaro; its exact component count, order, relative sizes, colours, cuts and mountings; and its clasp, extender, end caps and terminal tag. Where the written description and the photograph disagree, follow the photograph. Do not add, remove, resize, duplicate or rearrange a component, and do not turn a dangling charm into a set stone or a solid motif into a gemstone.

RESTYLE FREELY otherwise — the piece may be re-posed and re-draped into its most flattering arrangement, and the display card, packaging, labels, dust and fingerprints are removed. The photograph it came from was a quick reference shot; its accidental outline is not the product's shape.

Photorealistic and opaque, square, sharp to the edges of the piece. No people, hands, props, boxes, flowers, text or watermarks.$image$;

begin
  perform public.validate_prompt_body('describe', v_describe, true);
  perform public.validate_prompt_body('image', v_image, true);

  if position('Describe the object, not the photograph' in v_describe) = 0
     or position('WITHOUT a total' in v_describe) = 0
     or position('accidental outline' in v_image) = 0 then
    raise exception 'describe/image rewrite lost a required clause';
  end if;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Jewellery inspector — object not photograph', v_describe,
     'moonshotai/kimi-k3', false, now(), true, 'satin', v_actor),
    ('image', 'Pearl-ivory satin — short art-direction hero', v_image,
     'openai/gpt-image-2', false, now(), true, 'satin', v_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.version_created',
    jsonb_build_object(
      'reason', 'transient photograph pose leaked into the product record and the generated composition',
      'describe_words', cardinality(regexp_split_to_array(btrim(v_describe), '\s+')),
      'image_words', cardinality(regexp_split_to_array(btrim(v_image), '\s+')),
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
