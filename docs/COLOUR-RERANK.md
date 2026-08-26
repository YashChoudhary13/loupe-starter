# Colour-aware re-rank

## Why
SigLIP2 embeddings are shape/design-dominant and nearly colour-blind. Measured on the
production index (necklace-1096, three colourways): the **same design in a different
colour** sits at cosine 0.88–0.94 to itself, while **different but similar-looking
necklaces** sit at 0.87–0.93. The two bands overlap, so a white lookalike can outrank the
correct green SKU — exactly the "green necklace showed the white one at rank 10" report.

Isolating the non-gold foreground confirms colour *is* discriminative when you look past the
gold setting: necklace-1096's green image carries ~20 % green stone pixels and is L2 ≈ 0.42
from the all-white distractors in the 15-bin histogram, versus ~0.3 to its own siblings.
So a colour term can break the cosine ties the embedding cannot.

## What ships
- `match_references.colour` — an L1-normalised 15-bin foreground colour histogram
  (`worker/loupe_worker/colour.py`: 12 hue + 3 achromatic bins, over the u2net foreground).
- `match_search_colour(embedding, colour, limit, alpha)` — `alpha*cosine + (1-alpha)*colour_sim`
  (L2 on the histograms), max over views per SKU. Falls back to cosine per reference wherever
  `colour` is null, so a half-backfilled index still ranks sensibly.
- The worker computes and posts a colour signature on every embed and every identify, so all
  **new** references get colour automatically.
- Identify calls `match_search_colour` with `alpha = MATCH_COLOUR_ALPHA` (**default 1.0 =
  pure cosine**). The feature is a no-op until you both backfill colour and lower alpha.

## Backfill the existing index (one time)
The 3,823 references embedded before this feature have no colour yet. Colour needs only u2net
(no SigLIP), so this is cheap.

**Local (recommended, ~1 h on the Mac, no round-trip):**
```
npx tsx scripts/export-colour-manifest.ts            # runs/colour/manifest.jsonl
KMP_DUPLICATE_LIB_OK=TRUE python worker/backfill_colour.py   # runs/colour/colours.jsonl (resumable)
npx tsx scripts/import-colour.ts runs/colour/colours.jsonl
```

**Kaggle T4 (faster, ~15–20 min, catalogue only):**
1. `npx tsx scripts/export-colour-manifest.ts --catalogue-only`
2. Upload `runs/colour/manifest.jsonl` as a private Kaggle dataset `qimati-colour-manifest`.
3. Push/run `kaggle/colour_backfill.py` (GPU on, Internet on). Download `colours.jsonl`.
4. `npx tsx scripts/import-colour.ts colours.jsonl`
5. Do the private R2 originals locally (the manifest without `--catalogue-only` presigns them):
   `npx tsx scripts/export-colour-manifest.ts && python worker/backfill_colour.py && npx tsx scripts/import-colour.ts runs/colour/colours.jsonl`

The colour code is duplicated in `kaggle/colour_backfill.py`; the bin counts and thresholds
there MUST stay identical to `loupe_worker/colour.py`.

## Turn it on — but measure first
`alpha` is **not yet tuned on a real eval set**; do not enable it blind (standing rule: no
claim without a number). After backfilling:
1. Collect phone photos of known colour-variant SKUs (the green-necklace kind).
2. For each, compare the identify ranking at `alpha = 1.0` (cosine) vs 0.9, 0.8, 0.7. Score
   top-1/top-5, paired McNemar. Pick the highest alpha that helps and never hurts.
3. Set `MATCH_COLOUR_ALPHA` in Railway to that value. 1.0 disables it again.

Start the sweep near **0.9** (colour breaks near-ties only) rather than low — a small weight
reorders the 0.87–0.93 cluster without letting colour override a strong shape match.
