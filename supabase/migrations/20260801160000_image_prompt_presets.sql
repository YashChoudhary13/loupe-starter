-- Four saved image-prompt presets, selectable before a batch is uploaded.
--
-- Until now there was exactly one image prompt and the operator had to edit its
-- body to change the look. These are named, saved alternatives derived from the
-- SAME accepted prompt, so every block that has already been visually accepted
-- (lighting, shadows, camera, and the jewellery fidelity rules) is byte-identical
-- across the jewellery presets. Only the blocks that must differ were changed.
--
-- uses_composition is the load-bearing part. Two presets STAGE THE PRODUCT
-- THEMSELVES:
--
--   hand-chain  the piece is worn on a hand
--   bag         the bag stands upright on its base
--
-- The describer's composition classes all describe a piece lying on a surface
-- ("lay the piece flat in a relaxed open arc"). Injecting one into those presets
-- would send the image model two contradictory staging instructions and it would
-- resolve the conflict differently every time. So those presets carry no
-- {COMPOSITION_DETAIL} token at all, and resolveImagePrompt() refuses a prompt
-- whose token count disagrees with this flag — in BOTH directions.
--
-- The bag preset also replaces the FIDELITY block: the jewellery version talks
-- about chain links, bezels and plating and says nothing about fabric, weave or
-- printed lettering, which a bag prompt has to preserve exactly.

alter table public.prompts
  add column if not exists uses_composition boolean not null default true;

comment on column public.prompts.uses_composition is
  'Image prompts only. FALSE for a preset that stages the product itself (worn on a hand, bag standing); such a prompt must NOT contain {COMPOSITION_DETAIL}, because the describer''s classes all assume the piece is lying on a surface.';

alter table public.prompts
  add column if not exists preset_slug text;

comment on column public.prompts.preset_slug is
  'Stable identifier for a saved style preset (marble, yellow, hand-chain, bag). Null for prompts that are not presets.';

-- Presets are inserted as ARCHIVED, non-default versions. Nothing about the
-- currently accepted prompt changes until an operator deliberately promotes one
-- in /prompts — a prompt change alters every product's look and is never a
-- side effect of deployment (D51).
insert into public.prompts (kind, name, body, model, is_default, archived_at, uses_composition, preset_slug)
select
  'image'::public.prompt_kind,
  v.name,
  v.body,
  (select model from public.prompts
    where kind = 'image' and is_default and archived_at is null limit 1),
  false,
  now(),
  v.uses_composition,
  v.slug
from (values
  ('Marble surface', 'marble', 'A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — a polished white-and-cream marble surface with soft natural veining in warm
grey and pale gold, lit so the veining reads as subtle texture rather than pattern. Warm
ivory and champagne palette. The far background falls away into smooth creamy bokeh with
gentle warm highlights. No props, no risers, no boxes, nothing touching the piece.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
{{COMPOSITION_DETAIL}}

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.', true),
  ('Plain yellow backdrop', 'yellow', 'A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — a plain, seamless warm sand-yellow surface, evenly lit and completely
smooth, with no texture, veining, pattern or visible horizon. A single flat backdrop colour
in warm beige-yellow. No props, no risers, no boxes, no foliage, nothing touching the
piece.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
{{COMPOSITION_DETAIL}}

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.', true),
  ('Hand chain — worn', 'hand-chain', 'A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SUBJECT — the hand chain, shown worn. Remove display cards, backing, tags, price stickers,
plastic and any text, logo or branding that is not physically part of the piece. A hand and
forearm are REQUIRED for this shot and are not props to be removed. Skin is smooth, natural
and evenly toned, with no jewellery other than the piece itself.

BACKGROUND — soft ivory silk with gentle natural folds, warm in tone and strongly out of
focus. Monochromatic ivory and cream palette, smooth creamy bokeh. No props, no foliage,
nothing else in the frame.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing. The piece is WORN on a real human hand: the bracelet section
sits on the wrist, the connecting chain runs across the back of the hand, and the ring loops
over one finger. Show the back of a relaxed, elegantly posed hand with neat natural nails,
angled so the whole length of the piece is readable and unobscured. The hand occupies most
of the frame; the piece is the subject and stays completely sharp.

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — display cards, packaging, price tags, labels, text, logos, watermarks,
borders, frames, stands, clips, wires, extra or missing pieces, altered design, distorted
proportions or anatomy, extra or missing fingers, malformed hands, bent or melted metal,
duplicated components, harsh shadows, dark backgrounds, cool blue lighting, oversaturated
yellow, excessive bloom, excessive sparkle, star filters, motion blur, soft product focus,
noise, grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.', false),
  ('Bags — standing', 'bag', 'A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SUBJECT — the bag or pouch only. The source photograph may show it on a cluttered surface,
held in a hand, or inside packaging. Remove all of it: hands and fingers, tags, price
stickers, plastic, and any text or logo that is not physically printed on the product
itself. Present the piece as though photographed on its own.

BACKGROUND — a polished white-and-cream marble surface with soft natural veining in warm
grey and pale gold, lit so the veining reads as subtle texture rather than pattern. Warm
ivory and champagne palette. The far background falls away into smooth creamy bokeh with
gentle warm highlights. No props, no risers, no boxes, nothing touching the piece.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame with
even margins and clean negative space. The bag STANDS UPRIGHT on its base, holding its own
structured shape, turned to a gentle three-quarter angle so the front face and one side are
both readable. Sleek and taut — not slumped, folded, flattened or lying down. Slightly
elevated eye-level camera. Keep this framing identical for every product.

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the product itself. Reproduce the
bag exactly as photographed: shape, proportion, fabric weave and texture, stitching, seams,
piping, zip, pull, lining and every piece of hardware must match the source. Printed
artwork, illustration and LETTERING must be reproduced exactly as it appears — same words,
same spelling, same lettering style, same placement, same colours. Do not invent, restyle,
translate, re-letter or embellish any text. Do not add or remove pockets, straps, charms or
decoration. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, people, models, mannequins, display cards,
packaging, price tags, labels, watermarks, borders, frames, stands, clips, wires, props
touching the product, extra or missing pieces, altered design, misspelled or restyled
lettering, invented text, distorted proportions, a slumped or collapsed bag, duplicated
components, floating products, harsh shadows, dark backgrounds, cool blue lighting,
oversaturated yellow, excessive bloom, motion blur, soft product focus, noise, grain,
chromatic artifacts, plastic-looking materials, CGI or cartoon styling.', false)
) as v(name, slug, body, uses_composition)
where not exists (
  select 1 from public.prompts as p
   where p.kind = 'image' and p.preset_slug = v.slug
);
