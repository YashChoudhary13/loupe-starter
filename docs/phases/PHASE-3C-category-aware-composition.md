# Phase 3C — Category-aware composition

## Status

**Implemented, deployed and visually verified; not complete.**

Criteria 15, 16 and 18 pass. Criterion 17 fails because the current description model costs
$0.014816–$0.016851 per accepted call against a strict `< $0.006` target.

## Goal

Let the factual describe call choose one bounded presentation class while keeping all
composition prose owned and audited by application code. Preserve the two-call architecture,
cached retry/redo behavior, lease fencing, immutable R2 recovery and exact prompt history.

This feature does not classify Shopify products.

## Closed presentation vocabulary

| class | application-owned composition intent |
|---|---|
| `pair-upright` | matched pair, upright, front-facing and symmetric |
| `flat-curve` | necklace/long chain in a soft open curve |
| `standing-three-quarter` | ring standing on its band at three-quarter angle |
| `angled-band` | kada/bangle/cuff with opening toward the camera |
| `flat-arc` | flexible bracelet/anklet in an open arc |
| `tray-grid` | every separate item retained in aligned rows |

The exact prose lives in `src/lib/enhance/presentation.ts`. Database rows store only the
enum, whether it was a fallback, and the fallback reason.

## Describe contract

The live prompt requires one JSON object and nothing else:

```json
{"description":"<one factual 60–100 word paragraph>","presentation":"<one enum member>"}
```

Parsing is strict. Extra/missing fields, Markdown fences, non-strings, blank text, line
breaks, out-of-range word counts and invented presentation values fail. The original raw
provider output remains in bounded error detail.

## Image prompt resolution

The live image template contains exactly:

```text
{{PRODUCT_DESCRIPTION}}
{{COMPOSITION_DETAIL}}
```

With description injection enabled, the cached paragraph replaces the first token.
Otherwise the exact PRODUCT block is removed. The code-owned composition paragraph replaces
the second token. Missing, repeated or unresolved uppercase tokens stop before image
generation. `image_versions.prompt_text` is the exact resolved value sent to OpenRouter.

The Phase 3B FIDELITY block is byte-identical. The conflicting instruction to preserve the
source orientation was removed so a bounded presentation class can restage orientation
without permission to alter the jewellery.

## Fallback

Malformed structured output, invented presentation classes and exhausted describe failures
use only `flat-curve`. The row records:

```text
presentation_fallback = true
presentation_fallback_reason = <queryable error code>
```

The raw result remains in `description_error_detail`; audit events state that model
composition prose was not accepted. A legacy cached paragraph with no class also receives
`flat-curve` with `legacy_missing_presentation_class` and makes zero describe calls.

## Acceptance criteria

| criterion | result | evidence |
|---|---|---|
| 15 — five products, at least three classes, exact prompts | pass | five products, four classes; each code-owned paragraph occurs once; no unresolved tokens; stored prompt equals provider prompt |
| 16 — malformed/invented fallback | pass | linked production transaction recorded both reasons, `flat-curve`, attempt 5 and audit events; transaction rolled back |
| 17 — description cost `< $0.006` | **fail** | actual accepted costs $0.014816–$0.016851; mean $0.015928 |
| 18 — contact sheet and catalogue review | pass | five-row before/after sheet; consistent ivory catalogue treatment; source and result both contain 87 tray items |

Local evidence:

```text
.artifacts/phase3c-acceptance/evidence.json
.artifacts/phase3c-acceptance/before-after-contact-sheet.png
.artifacts/phase3c-acceptance/prompts/
.artifacts/phase3c-acceptance/cleanup.json
.artifacts/phase3c-description-eval/
```

## Completion gate

Do not declare this phase complete or change production models from the description-only
comparison. A candidate must be explicitly selected, configured, and run through a fresh
comparable five-product end-to-end acceptance. Every description must be factual, valid,
class-correct and below $0.006; the generated images must retain jewellery fidelity and all
87 tray items.
