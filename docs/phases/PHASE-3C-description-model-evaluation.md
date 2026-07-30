# Phase 3C — Isolated description-model evaluation

## Production state

This evaluation made description calls only. It wrote no production rows, generated no
candidate images, and did not change `DESCRIBE_MODEL`. Production remains:

```text
openai/gpt-5.6-sol
```

Every candidate saw the same five preserved 1024 px source copies, the exact live Phase 3C
describe prompt, reasoning effort `minimal`, a 256-token completion ceiling and the strict
production parser.

## Results

| candidate | strict JSON | expected classes | total cost | mean cost | factual review | decision |
|---|---|---|---:|---:|---|---|
| `openai/gpt-5.4-mini` | 4/5 | 4/5 | $0.010254 | $0.0020508 | fail | reject |
| `openai/gpt-5.4-nano` | 5/5 | 5/5 | $0.0028234 | $0.00056468 | fail | reject |
| `google/gemini-3.1-flash-lite-preview` | 5/5 | 5/5 | $0.00283525 | $0.00056705 | fail | reject |
| `google/gemini-3-flash-preview` | 5/5 | 5/5 | $0.005572 | $0.0011144 | pass | shortlist only |
| `anthropic/claude-haiku-4.5` | 0/5 | 0/5 parsed | $0.011962 | $0.0023924 | fail | reject |

All 25 individual provider-reported costs were below $0.006, including responses that
failed parsing.

## Review notes

- **GPT-5.4 Mini:** selected `angled-band` for a flexible bracelet and truncated the tray
  JSON at the unchanged 256-token ceiling. It also called the flexible bracelet rigid.
- **GPT-5.4 Nano:** all machine gates passed, but it described the flexible heart-chain
  piece as having a rigid snake-like bar. That factual error is unsafe in an image prompt.
- **Gemini 3.1 Flash Lite Preview:** all machine gates passed, but it guessed cubic
  zirconia, referred to the display tray and invented an unseen earring post.
- **Gemini 3 Flash Preview:** all five objects parsed, matched
  `flat-curve/flat-arc/flat-arc/tray-grid/pair-upright`, stayed below the cost target, and
  produced acceptable factual descriptions. Its use of “flat snake chain” is comparable to
  terminology returned by the current model, but must be watched in the image comparison
  because the source can also be described as herringbone.
- **Claude Haiku 4.5:** wrapped every object in Markdown fences, so the exact production
  parser rejected all five. It also guessed named gemstones and unseen earring fittings.

## Decision gate

Gemini 3 Flash Preview is the only description-only shortlist. It is not approved for
production and does not make criterion 17 pass.

The next authorized step, if chosen explicitly, is a fresh isolated five-product
end-to-end comparison using Gemini 3 Flash Preview descriptions with the unchanged image
model and image prompt. It must prove:

1. five strict JSON results and five correct classes again;
2. every actual description cost below $0.006;
3. jewellery form, chain construction, stones, settings and pair count do not degrade;
4. the tray retains all 87 items in aligned rows; and
5. only after review, an explicit decision to update production configuration and evidence.

Raw evidence is retained in:

```text
.artifacts/phase3c-description-eval/evidence-batch-1.json
.artifacts/phase3c-description-eval/evidence.json
```
