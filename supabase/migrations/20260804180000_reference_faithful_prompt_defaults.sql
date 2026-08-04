-- Reference-faithful enhancement defaults.
--
-- The previous descriptor explicitly prohibited exact component counts, while
-- the image prompt asked for a warm "luxury" restaging. Together those rules
-- removed the topology needed to identify a piece and encouraged the image
-- model to redesign it: loose charms became prong-set stones, chains became
-- thicker, extenders were duplicated, motifs disappeared, and sculptural
-- pendants were simplified.
--
-- This revision follows the image-editing contract recommended for GPT Image 2:
-- state what may change, state every invariant, and make the reference image
-- authoritative. It also revises every saved preset, not only the live satin
-- pair. Prompt history remains immutable; the preset promoter is changed to use
-- the newest revision for each slug/kind instead of the original flawed one.

create or replace function public.promote_prompt_preset(
  p_slug text,
  p_actor text
)
returns table (kind public.prompt_kind, prompt_id uuid, changed boolean)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_slug text := nullif(btrim(coalesce(p_slug, '')), '');
  v_half record;
  v_current_id uuid;
begin
  if v_slug is null then
    raise exception 'promote_prompt_preset: slug is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'promote_prompt_preset: actor is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.prompts
     where preset_slug = v_slug and kind = 'describe'
  ) then
    raise exception 'promote_prompt_preset: preset "%" has no describe prompt', v_slug
      using errcode = '22023',
            hint = 'A preset must define both the describer and the image prompt.';
  end if;
  if not exists (
    select 1 from public.prompts
     where preset_slug = v_slug and kind = 'image'
  ) then
    raise exception 'promote_prompt_preset: preset "%" has no image prompt', v_slug
      using errcode = '22023',
            hint = 'A preset must define both the describer and the image prompt.';
  end if;

  for v_half in
    -- Presets are versioned. The newest revision is the maintained template;
    -- promoted copies are newer still and carry the same reviewed body.
    select distinct on (p.kind) p.kind, p.id
      from public.prompts as p
     where p.preset_slug = v_slug
     order by p.kind, p.created_at desc, p.id desc
  loop
    select p.id
      into v_current_id
      from public.prompts as p
     where p.kind = v_half.kind
       and p.is_default
       and p.archived_at is null
       and p.preset_slug is not distinct from v_slug;

    if found then
      kind := v_half.kind;
      prompt_id := v_current_id;
      changed := false;
    else
      kind := v_half.kind;
      prompt_id := public.promote_prompt_version(v_half.id, p_actor);
      changed := true;
    end if;
    return next;
  end loop;
  return;
end;
$$;

comment on function public.promote_prompt_preset(text, text) is
  'Promotes both halves of the newest maintained revision of a style preset in one transaction. A half already live is left alone.';

revoke all on function public.promote_prompt_preset(text, text)
  from public, anon, authenticated;
grant execute on function public.promote_prompt_preset(text, text)
  to service_role;

do $migration$
declare
  v_actor constant text := 'migration:20260804180000';

  v_jewellery_describer constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority. Produce a factual identity record of ONLY the jewellery; ignore display cards, packaging, hands, surfaces, shadows, labels and any hardware that is not physically part of the product.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; construction and topology, including exact strand count, chain type and gauge, branches and connections; a component ledger with the exact visible count and sequence of distinct pendants, charms, motifs, beads and individually separated stones, tracing each side from an end toward the centre and preserving asymmetry; every component's shape, colour, cut and mounting method; central feature silhouette and relief; exact clasp, extender and terminal-tag count and type; and relative sizes, spacing and proportions.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- Exact counts are mandatory for visible discrete design elements, strands, fittings and individually separated stones. Do not replace a count with "several", "multiple" or "scattered". Do not count ordinary chain links or fabricate a count for a continuous pavé field.
- Distinguish a drilled, dangling or jump-ring-mounted charm from a prong, bezel or glued setting. Distinguish solid-metal motifs from gemstones.
- Preserve irregular spacing, side-specific order and every visible asymmetry. Do not describe an idealised or symmetrical version.
- If a detail is partly obscured, say that it is partly obscured and report only what is visible. Never infer a hidden component, material or gemstone species. Use factual visual terms such as "clear faceted element" when material is uncertain.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, lighting or photography.

Choose exactly one presentation class:
pair-upright for a matched pair; flat-curve for a necklace or long chain; standing-three-quarter for a ring; angled-band for a kada, bangle, cuff or rigid bracelet; flat-arc for a flexible bracelet or anklet; tray-grid for multiple separate items on one tray or card.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"<pair-upright|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>"}$describe$;

  v_hand_chain_describer constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority. Produce a factual identity record of ONLY the hand-chain jewellery; ignore the display card, packaging, hand, skin, surface, shadows, labels and any hardware that is not physically part of the product.

Inspect the image closely before answering. In one paragraph, cover in this order: item type and exact item quantity; metal colour and finish; the wrist section and its closure; exact number of chains or branches crossing the hand and every junction; exact number and construction of finger loops or rings; exact strand count, chain type and gauge; a component ledger with the exact visible count and connection order of charms, motifs, beads and individually separated stones; every component's shape, colour, cut and mounting method; exact clasp, extender and terminal-tag count and type; and relative sizes, spacing and proportions.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- Exact counts are mandatory for all visible sections, branches, loops, junctions, fittings and discrete design elements. Do not use "several", "multiple" or "scattered" in place of a count. Do not count ordinary chain links or fabricate a count for continuous pavé.
- State exactly what attaches to the wrist section, what crosses the hand, and what attaches to each finger loop. Preserve every asymmetry.
- Distinguish drilled, dangling and jump-ring-mounted charms from prong, bezel or glued settings, and solid-metal motifs from gemstones.
- If partly obscured, say so and report only visible facts. Never infer hidden components, materials or gemstone species.
- No claims about beauty, quality, luxury or value. Do not describe the hand pose, skin, background, packaging, lighting or photography.

Choose the closest presentation class from: pair-upright, flat-curve, standing-three-quarter, angled-band, flat-arc, tray-grid. The image preset stages the product on a hand, so this class is recorded but not injected into the image prompt.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"<pair-upright|flat-curve|standing-three-quarter|angled-band|flat-arc|tray-grid>"}$describe$;

  v_bag_describer constant text := $describe$You are the visual-inspection stage of a reference-faithful product photo edit. The source photograph is the sole authority. Produce a factual identity record of ONLY the bag or pouch; ignore packaging, hands, surfaces, shadows, price tags and anything not physically part of the product.

Inspect the image closely before answering. In one paragraph, cover in this order: exact item quantity; product type; exact silhouette and whether it is rigid, semi-structured or soft; material, weave or grain, colour and finish; exact panel, pocket and compartment layout visible in the source; exact closure count and type; exact handle and strap count, construction and attachment points; exact hardware count, shapes and metal colours; stitching, seams, piping and trim; and any artwork or lettering. Transcribe lettering only when fully legible, with exact spelling, capitalisation, colour and placement.

Rules:
- 80 to 200 words. One paragraph. No headings or bullet points inside the description.
- Exact counts are mandatory for visible pockets, closures, handles, straps, attachments and hardware. Preserve asymmetry and natural softness; do not describe an idealised, taut or more structured version.
- If a feature is partly obscured, say so and report only visible facts. Never invent an unseen side, pocket, gusset, lining, material or word. If lettering is uncertain, describe it as illegible rather than guessing.
- No claims about beauty, quality, luxury or value. Do not describe the background, packaging, hand, lighting or photography.

Return presentation "standing-three-quarter". The bag preset stages the product itself, so this class is recorded but not injected into the image prompt.

Return ONLY raw JSON with exactly these fields and no markdown:
{"description":"<one factual 80-200 word paragraph>","presentation":"standing-three-quarter"}$describe$;

  v_jewellery_image_base constant text := $image$Edit the supplied reference photograph into one square e-commerce catalogue image. This is a product-preservation edit, not a product redesign.

PRODUCT
{{PRODUCT_DESCRIPTION}}

BACKGROUND — <<BACKGROUND>>

SUBJECT AND CLEANUP — isolate the jewellery that is physically present in the reference. Remove only removable surroundings: display card, packaging, price tags, stickers, hands, clips and unrelated text or branding. Do not remove a tag, charm or fitting that is attached to the jewellery. Keep the entire product visible, unobstructed and sharply focused.

COMPOSITION — centre the product with clean margins, using roughly 65-75% of the square frame. Use a straight-on or only slightly elevated catalogue angle. Restage only enough to separate the product from its original support:
{{COMPOSITION_DETAIL}}

REFERENCE AUTHORITY — highest priority. The reference image is the sole visual authority; the PRODUCT record is an inspection aid. If they conflict, follow the visible reference. Preserve the exact same physical product: item count; continuous topology and connections; strand count; chain-link style and gauge; component count, sequence, side placement and spacing; stone or charm colour, shape, cut and mounting; solid-metal motifs; pendant silhouette and sculptural relief; clasp, extender and terminal-tag count and type; finish, plating colour, proportions, scale and asymmetry.

PERMITTED CHANGE — flexible chain may bend naturally into the requested pose, but every component must stay attached to its original section in the same sequence and at the same relative spacing. Rigid parts keep their geometry. Only surroundings, permitted pose, lighting and light photographic cleanup may change.

FORBIDDEN PRODUCT CHANGES — no extra, missing, duplicated, mirrored or redistributed component. Never turn a loose drilled, dangling or jump-ring-mounted charm into a prong- or bezel-set stone. Never turn a solid-metal motif into a gemstone or remove a motif. Do not change stone cuts, settings or colours; simplify engraved or sculptural detail; thicken or replace the chain; enlarge stones or pendants; add a second extender or clasp; regularise spacing; make an asymmetric design symmetrical; or "complete" a detail that is unclear. Do not beautify the product into a more expensive-looking design.

LIGHTING AND FINISH — soft warm-neutral diffused studio light with accurate metal colour, controlled natural highlights and one subtle contact shadow. Apply only light cleaning and colour correction. No saturated yellow cast, artificial mirror polish, added sparkle, glitter, starbursts, bloom or harsh contrast. The whole product is crisp; background texture may soften gently. Photorealistic materials, clean edges, no halos, no CGI appearance.

OUTPUT — one opaque square product photograph only. No people, skin, mannequins, props, boxes, stands, watermarks, borders or added text.$image$;

  v_satin_background constant text := 'an opaque ivory-champagne satin surface with broad, gentle folds kept away from thin chains and small components. Warm-neutral ivory and cream, restrained texture, no props, risers, boxes, flowers or objects touching the product.';
  v_marble_background constant text := 'an opaque white-and-cream marble surface with sparse, low-contrast warm-grey veining. The veining must remain secondary to the product. No props, risers, boxes, flowers or objects touching the product.';
  v_yellow_background constant text := 'an opaque seamless warm sand-yellow surface with no pattern, veining, horizon or texture. Keep the yellow restrained so it does not contaminate the product colour. No props or objects touching the product.';

  v_hand_chain_image constant text := $image$Edit the supplied reference photograph into one square e-commerce catalogue image of the exact hand-chain product worn on a hand. This is a product-preservation edit, not a product redesign.

PRODUCT
{{PRODUCT_DESCRIPTION}}

BACKGROUND — opaque ivory satin with broad soft folds, warm-neutral in colour and gently out of focus. No props, boxes, flowers, text or watermarks.

SUBJECT AND CLEANUP — remove the original display card, packaging, price tags, stickers and unrelated branding. A single natural adult hand and forearm are required only to demonstrate fit. Show the back of a relaxed hand with neat natural nails. Keep every part of the jewellery visible and sharply focused; the hand must not cover a junction, charm, loop or fitting.

COMPOSITION — fit the product according to its actual construction in the reference and PRODUCT record. Place the wrist section at the wrist, route the exact source number of connecting chains across the hand, and fit the exact source number of finger loops or rings to fingers. Do not assume there is one branch or one loop. Use a pose that reveals the complete topology without stretching, rerouting or adding chain.

REFERENCE AUTHORITY — highest priority. The reference image is the sole visual authority; the PRODUCT record is an inspection aid. If they conflict, follow the visible reference. Preserve exact item, section, branch, junction, strand, finger-loop, charm, motif, stone, clasp, extender and terminal-tag counts; all connections and sequence; chain style and gauge; component colours, shapes, cuts and mountings; solid-metal motifs; finish, plating colour, proportions and asymmetry.

FORBIDDEN PRODUCT CHANGES — no extra, missing, duplicated, mirrored or redistributed component. Never convert a loose charm into a prong- or bezel-set stone, or a solid-metal motif into a gemstone. Do not change connection points, split or merge branches, add a ring loop, simplify relief, thicken chain, enlarge features, add a second extender, regularise spacing or invent hidden detail. The new hand may change; the product may not.

LIGHTING AND FINISH — soft warm-neutral diffused studio light, accurate metal colour, controlled highlights and realistic contact shadows on skin. Only light cleaning and colour correction. No saturated yellow cast, artificial mirror polish, extra sparkle, bloom, anatomy distortion, extra or missing fingers, product blur, halos or CGI appearance.$image$;

  v_bag_image constant text := $image$Edit the supplied reference photograph into one square e-commerce catalogue image of the exact same bag or pouch. This is a product-preservation edit, not a product redesign.

PRODUCT
{{PRODUCT_DESCRIPTION}}

BACKGROUND — an opaque white-and-cream marble surface with sparse low-contrast warm-grey veining and a clean warm-neutral studio backdrop. No props, risers, boxes, flowers or objects touching the product.

SUBJECT AND CLEANUP — isolate the physical product from packaging, hands, price tags, stickers and unrelated branding. Keep all product artwork and lettering. Show the complete silhouette with crisp clean edges and no halos.

COMPOSITION — centre the product with clean margins, occupying roughly 65-75% of the square frame. Stand it naturally on its actual base when the source construction permits, using a near-front view that prioritises the source-visible face. Preserve natural softness: a soft bag stays soft and a structured bag stays structured. Do not make it taut, add internal volume or invent an unseen side merely to force a three-quarter view.

REFERENCE AUTHORITY — highest priority. The reference image is the sole visual authority; the PRODUCT record is an inspection aid. If they conflict, follow the visible reference. Preserve exact silhouette, proportions, material texture, weave or grain, panel and pocket layout, closure count, handle and strap count and attachment points, hardware count and shapes, stitching, seams, piping, trim, artwork, lettering, colours and asymmetry.

FORBIDDEN PRODUCT CHANGES — do not add, remove, duplicate, mirror or relocate a pocket, panel, gusset, zip, pull, clasp, handle, strap, charm, seam, word or decoration. Do not smooth away texture, increase structure, invent lining or unseen details, redesign artwork, translate text, change spelling or capitalisation, or replace uncertain lettering with invented text.

LIGHTING AND FINISH — soft warm-neutral diffused studio light with accurate colour, controlled highlights and one subtle contact shadow. Apply only light cleaning and colour correction. No saturated cast, artificial gloss, exaggerated structure, harsh contrast, product blur, halos, warped lettering or CGI appearance. Output one opaque square product photograph with no people, watermarks, borders or added text.$image$;

  v_satin_image text;
  v_marble_image text;
  v_yellow_image text;
  v_describe_id uuid;
  v_image_id uuid;
  v_latest record;
begin
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
    ('describe', 'Reference-faithful jewellery inspector — exact topology', v_jewellery_describer, 'openai/gpt-5.6-sol', true, null, true, 'satin', v_actor),
    ('image', 'Reference-faithful ivory satin catalogue', v_satin_image, 'openai/gpt-image-2', true, null, true, 'satin', v_actor);

  -- Resolve the two unique live rows for the audit events below.
  select id into v_describe_id from public.prompts
   where kind = 'describe' and is_default and archived_at is null;
  select id into v_image_id from public.prompts
   where kind = 'image' and is_default and archived_at is null;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at,
    uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Marble surface — reference-faithful inspector', v_jewellery_describer, 'openai/gpt-5.6-sol', false, now(), true, 'marble', v_actor),
    ('image', 'Marble surface — reference-faithful', v_marble_image, 'openai/gpt-image-2', false, now(), true, 'marble', v_actor),
    ('describe', 'Plain yellow — reference-faithful inspector', v_jewellery_describer, 'openai/gpt-5.6-sol', false, now(), true, 'yellow', v_actor),
    ('image', 'Plain yellow backdrop — reference-faithful', v_yellow_image, 'openai/gpt-image-2', false, now(), true, 'yellow', v_actor),
    ('describe', 'Hand chain — exact connection inspector', v_hand_chain_describer, 'openai/gpt-5.6-sol', false, now(), true, 'hand-chain', v_actor),
    ('image', 'Hand chain worn — reference-faithful', v_hand_chain_image, 'openai/gpt-image-2', false, now(), false, 'hand-chain', v_actor),
    ('describe', 'Bags — exact construction inspector', v_bag_describer, 'openai/gpt-5.6-sol', false, now(), true, 'bag', v_actor),
    ('image', 'Bags standing — reference-faithful', v_bag_image, 'openai/gpt-image-2', false, now(), false, 'bag', v_actor);

  perform public.validate_prompt_body('image', v_satin_image, true);
  perform public.validate_prompt_body('image', v_marble_image, true);
  perform public.validate_prompt_body('image', v_yellow_image, true);
  perform public.validate_prompt_body('image', v_hand_chain_image, false);
  perform public.validate_prompt_body('image', v_bag_image, false);

  if position('Exact counts are mandatory' in v_jewellery_describer) = 0
     or position('Do NOT state exact counts' in v_jewellery_describer) > 0
     or position('reference image is the sole visual authority' in lower(v_satin_image)) = 0
     or position('jump-ring-mounted charm' in v_satin_image) = 0 then
    raise exception 'reference-faithful prompt invariant is missing';
  end if;

  -- The newest maintained half of every preset must use the selected production
  -- model and the new identity contract.
  for v_latest in
    select distinct on (preset_slug, kind)
           preset_slug, kind, model, body
      from public.prompts
     where preset_slug is not null
     order by preset_slug, kind, created_at desc, id desc
  loop
    if (v_latest.kind = 'describe' and v_latest.model <> 'openai/gpt-5.6-sol')
       or (v_latest.kind = 'image' and v_latest.model <> 'openai/gpt-image-2') then
      raise exception 'preset % has the wrong % model', v_latest.preset_slug, v_latest.kind;
    end if;
    if v_latest.kind = 'describe'
       and position('Exact counts are mandatory' in v_latest.body) = 0 then
      raise exception 'preset % still has the old descriptor contract', v_latest.preset_slug;
    end if;
    if v_latest.kind = 'image'
       and position('REFERENCE AUTHORITY' in v_latest.body) = 0 then
      raise exception 'preset % still has the old image-edit contract', v_latest.preset_slug;
    end if;
  end loop;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values
    (
      'prompt', v_describe_id, 'prompt.default_replaced',
      jsonb_build_object(
        'kind', 'describe',
        'model', 'openai/gpt-5.6-sol',
        'contract', 'exact-count-topology-ledger',
        'description_words', '80-200',
        'presets_revised', jsonb_build_array('satin', 'marble', 'yellow', 'hand-chain', 'bag')
      ),
      v_actor
    ),
    (
      'prompt', v_image_id, 'prompt.default_replaced',
      jsonb_build_object(
        'kind', 'image',
        'model', 'openai/gpt-image-2',
        'contract', 'reference-authority-surgical-edit',
        'known_failures_locked', jsonb_build_array(
          'component-count', 'component-sequence', 'chain-topology',
          'mounting-method', 'extender-count', 'solid-motif', 'pendant-relief'
        ),
        'presets_revised', jsonb_build_array('satin', 'marble', 'yellow', 'hand-chain', 'bag')
      ),
      v_actor
    );
end
$migration$;
