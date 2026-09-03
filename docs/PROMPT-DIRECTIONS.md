# Prompt Directions — Jewellery Image Enhancement (ChatGPT / gpt-image)

Playbook distilled from the Aug 23–28 and Sep 1 2026 prompt sessions. Use this to write
new enhancement prompts without re-deriving the system. Every rule here was learned from
a real failure.

## 1. Universal prompt skeleton

Every generation prompt has these sections, in this order:

```
Re-photograph this exact <piece> as a close-up editorial product shot in the style of a
premium minimalist jewellery brand. Use the attached photo as the only reference for the
design; ignore its background, the hand, the packaging, the plastic backs and the lighting.

KEEP EXACTLY: <forensic description — see §2>. Do not redesign, upgrade, simplify or add anything.

SCENE / BACKDROP: <see §3>

STAGING: <pose + crop — see §4>

LIGHT: <key light + per-stone-colour lines — see §5>

OUTPUT: square, photorealistic, no hands, ears, neck, mannequin, text, watermark, or extra
jewellery; nothing in frame beyond the <ground> and this <piece>.
```

Worn shots swap SCENE/STAGING for MODEL/HAND + STAGING blocks (§6).

## 2. KEEP EXACTLY — forensic description rules

The model redraws anything you leave vague. Always state:

- **Exact counts**: stones, beads, charms, petals, chain strands. Count them in the photo
  first. Wrong count in the prompt = wrong product in the render (12-bead bracelet came
  back with 10; 4 beads written for a 2-bead necklace propagated for several rounds).
- **Cuts by name**: pear, oval, cushion (say "clearly square, not a fourth oval"), marquise,
  radiant, heart-cut, round brilliant.
- **How things attach**: "threaded inline — the chain passes straight through, nothing
  dangles" vs "hangs freely from its own small jump ring". This single distinction caused
  the most rework. Stations sit ON the chain; charms hang BELOW it.
- **Orientation**: which way points the sprig/bud/tail, per side. Fix it relative to the
  chain run ("petals point up the chain toward the clasp, stone toward the centre"), and
  say whether the pair is mirrored or identical — check the photo, don't assume mirrored.
- **Proportion guards**: "the chain is very fine, each link no wider than one quarter of the
  round stone's diameter — never chunky" (renders default to heavy chain, which misleads on
  size); "this is a small stud, only slightly taller than wide — never stretched into long
  thin leaves" (renders elongate compact studs into dangles). Give mm if needed.
- Close with the fixed line: *"Do not redesign, upgrade, simplify or add anything."*

## 3. House scene (current catalogue look)

Lying pieces (studs, bracelets, flat-lay chains):

> a seamless ground of deep charcoal-grey clay plaster with a fine natural stone texture,
> softly lit by a warm circular pool of light centred behind the piece that fades into
> darker charcoal toward the corners. One hard, narrow diagonal band of window light rakes
> across the surface just behind it. No props, no fabric, no flowers, no objects.

Hanging pieces (necklaces, huggie drops, stud-top dangles): same wall, phrased as backdrop;
piece hangs a few centimetres in front, one soft offset shadow.

Rationale: gold, clear stones and coloured stones all need **luminance contrast**. Cream,
beige, satin folds kill gold at thumbnail size. Charcoal is the safe house ground; keep it
across the collection so the grid reads as one shoot.

Approved alternates: white plaster + hard window-shadow band (light grid), black marble
wet-look mirror (max sparkle for clear stones). Never: cream/beige/sand, forest green under
green stones, any texture with pits at stone scale (kills tennis rows).

## 4. Staging per category

| Category | Pose | Crop |
|---|---|---|
| Necklace, solid pendant / threaded stations | draped or hanging, 30° down if draped | front run spans ~4/5 width, hero station in lower third, ~1/5–1/8 frame width each; chain exits top corners; most of necklace out of frame |
| Necklace, dangling charms / layered | **hanging**, straight on, gravity | charm row / charm in middle band; layered = nested Vs, four separate top exits |
| Studs (posts at back) | both lie face-up, side by side, tilted a few degrees toward each other, gap ≈ half an earring-width, 30° down | pair fills ~3/4 frame width |
| Huggie / stud-top drops | suspended straight on, hoops level, drops vertical under gravity | pair fills ~3/4 frame height, gap ≈ one drop-width |
| Bracelets | fastened (clasp clipped to extender), one relaxed oval, 35° down | oval fills ~2/3 frame; tag angled so no text |
| Hand chains (product-only) | gentle diagonal S-curve, station stretch through centre | stations span ~2/3 width; chains exit opposite corners |

Never stage a physically impossible pose (drop earrings standing on their tips). Hanging =
how drops are worn.

## 5. Light block

Base: one hard, small key from the upper left at a low angle + gentle fill so the ground
keeps detail. "Rich saturated gold with bright liquid highlights — never flat or pale
yellow." Every pavé stone gets "its own tiny bright point". Fine chains: "the chain
separates from the ground along its whole run".

Per stone colour (paste verbatim):

- Clear: `icy, bright, colourless, a crisp white specular point and visible facet flashes,
  never milky, grey or yellow-tinted` (clear stones only sparkle under a hard point light)
- Green: `luminous saturated emerald green, never dark, olive, teal or black`
- Red: `luminous saturated ruby with a crisp white specular point, never dark or maroon`
- Pink: `luminous soft baby pink, delicate and bright, never magenta, purple or washed-out`
- Pearl / mother-of-pearl: `soft iridescent sheen, one gentle white highlight, clearly
  brighter than the ground`

## 6. Worn shots

- **Neck**: crop below lips → upper chest (or throat/collarbones only for macro). One
  model, warm medium skin, real texture ("fine pores, soft natural sheen, no plastic
  smoothing"). Piece = sharpest thing in frame. Threaded stations "lie flat with the stem
  line following the chain, like beads on a string".
- **Hand**: back of hand to camera. ANATOMY GUARDS verbatim: "exactly five fingers with
  natural proportions and joints, one thumb on the correct side, clean bare nails, no other
  jewellery". Count fingers before approving; expect ~1 in 3 failures.
- **Reality check**: full worn re-renders of fine hand chains are the least reliable
  category (piece gets redrawn: wrong length, wrong stone direction). Preferred fallback:
  **background-swap edit of the real worn photo** — keep hand + jewellery pixel-exact,
  replace surroundings with the charcoal backdrop, relight, square crop. Cheap and truthful.
- Macro close-ups are standard practice, not misleading — the misleading thing is a chunky
  rendered chain. Fix the chain-gauge guard, then cover scale with: image 2 = worn shot,
  image 3 = flat full piece or Loupe measurement variant, plus mm in listing text.

## 7. Edit prompts (fixing an existing render)

- Pattern: `Edit this image. Keep <everything else> exactly as it is. Change ONLY <one thing>.`
- **One change per pass.** Stacked instructions make the model rebuild the whole design.
  Queue further fixes as separate passes.
- Every edit prompt ends: `Nothing else changes. Photorealistic, same square framing, no
  text or watermark.`
- Geometry language that works: clock positions ("stone swings from 12 to about 11
  o'clock"), rotation direction + degrees, "exact mirror image of the right one — copied,
  NOT mirrored" (choose deliberately), "midway between the two beads, equal bare chain
  above and below".
- Reference-image trick: attach render first + real photo second; "the second image is the
  real product — use it only as reference for <the one feature>".
- Colour swaps: fresh generation on the source photo beats editing a coloured render —
  tints survive edits. If editing anyway: "no trace of pink left anywhere, including
  reflections on the bezel".
- Know when to stop: if two passes both miss (the bow case), the model is at its limit —
  ship the best render or fall back to §6's background-swap edit.

## 8. Failure catalogue (symptom → fix)

| Symptom | Fix |
|---|---|
| Piece tiny, scene dominates | tighten crop numbers (§4), "the necklace is the subject and fills the frame" |
| Gold vanishes at thumbnail | dark plain ground; luminance contrast, not hue |
| Clear stones milky/dull | hard small key + clear-stone line (§5) |
| Chain drawn chunky | chain-gauge proportion guard (§2) |
| Stations hang instead of threaded | "threaded inline… nothing dangles" + "the chain never runs continuous above a station" |
| Sprig/charm flipped or rotated | orientation spec per side, clock positions, copy-not-mirror |
| Compact stud stretched into dangle | squat-ratio guard, mm dimensions |
| Cluster loosened, cuts drifted | "edges touching, no gold gaps", name each cut, "cushion clearly square" |
| Extra/missing stones or beads | exact counts + "count them before finishing" |
| Bow/organic shape over-idealised | describe the asymmetry explicitly ("uneven loops, crossed tails, never a perfect symmetric bow") |
| Run too long on worn shot | span limits ("ends well before the knuckles / wrist crease") |
| Brand card text | never render packaging; shoot pieces without the card |
| AI hand artefacts | anatomy guards; or background-swap the real photo |

## 9. Workflow notes

- One image per ChatGPT turn; for batches, one master prompt + per-piece `[DROP]`/`[PIECE]`
  swap lines, attach photos one at a time.
- Always attach the ORIGINAL product photo as design ground truth (not a previous render),
  except when editing a specific render.
- Verify against the real photo before approving: counts, orientation, chain gauge,
  proportions, colours. The tulip-orientation bug took five rounds because the reference
  was itself an AI image — ground truth photos only.
- Loupe's prompt matrix cores (necklace draped/hanging, chain-bracelet, anklet-worn) encode
  the same rules; fold any new learning into `loupe-starter/src/lib/prompts/matrix.ts` and
  log in DECISIONS.md.
