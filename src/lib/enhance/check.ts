import { EnhancementError } from './errors'

/**
 * D120 — the render checker.
 *
 * Even the best editing model preserves the exact product in well under half of
 * renders (Photoroom fidelity benchmark, July 2026), so every generation is
 * verified against the source photograph by a vision model before it is
 * accepted. A failed verdict earns one bounded regeneration with targeted
 * correction lines appended; the second render is accepted either way and the
 * verdict is recorded for the operator. The checker itself is fail-open: a
 * checker outage must never stop the enhancement queue, so any check error is
 * recorded and the render accepted as if unchecked.
 */

/**
 * The failure vocabulary, distilled from the manual prompt-engineering failure
 * catalogue (loupe-starter/docs/PROMPT-DIRECTIONS.md §8). Each code maps to one
 * correction line the retry appends. Codes are canonical-ordered so the retry
 * prompt is a deterministic function of (base prompt, codes) — which is what
 * lets a crashed worker reconstruct the exact retry prompt from stored
 * metadata during R2 recovery.
 */
export const CHECK_FAILURE_CODES = [
  'count',
  'gauge',
  'shape',
  'stone_colour',
  'metal_colour',
  'attachment',
  'orientation',
  'proportion',
  'artefact',
] as const

export type CheckFailureCode = (typeof CHECK_FAILURE_CODES)[number]

const CORRECTION_LINES: Record<CheckFailureCode, string> = {
  count:
    'COUNT — render exactly the number of stones, beads, charms and strands the source photograph shows; count them before finishing and never add or remove one.',
  gauge:
    'CHAIN GAUGE — the chain is very fine: match the photographed link size exactly, each link no wider than one quarter of the smallest stone’s diameter, never chunky.',
  shape:
    'SHAPE — reproduce each component’s real outline exactly as photographed, including irregularity; never smooth, symmetrise, enlarge or restyle it.',
  stone_colour:
    'STONE COLOUR — every stone keeps its exact photographed hue and clarity; clear stones stay icy and colourless, coloured stones stay their own colour, never tinted or darkened.',
  metal_colour:
    'METAL COLOUR — reproduce the exact metal colour photographed; never convert one metal into another and never wash the gold pale.',
  attachment:
    'ATTACHMENT — components attach exactly as photographed: threaded stations sit ON the chain with it passing straight through, dangling charms hang BELOW it from their own ring; never convert one into the other.',
  orientation:
    'ORIENTATION — every motif, drop and sprig points exactly the way the photograph shows, per side; never mirror, flip or rotate one.',
  proportion:
    'PROPORTIONS — keep each component’s real height-to-width ratio and its real size relative to the chain; compact pieces stay compact, never stretched or inflated.',
  artefact:
    'CLEAN RENDER — one single soft shadow only, no double shadows or ghost blobs, the chain runs as one smooth continuous curve with no kinks, and nothing extra appears in the frame.',
}

export interface CheckVerdict {
  readonly pass: boolean
  readonly failures: readonly { code: CheckFailureCode; detail: string }[]
}

/**
 * The checker sees the source photograph first and the render second. It
 * judges product identity only: the render is deliberately re-posed and
 * re-staged on a new scene, so pose, background, lighting, crop and shadow
 * differences are correct and must never be flagged.
 */
export function checkPrompt(productDescription: string | null): string {
  const ledger = productDescription?.trim()
    ? `\n\nA factual identity record of the product, written from Image 1 by an earlier inspection, to check counts and construction against:\n${productDescription.trim()}\n`
    : '\n'
  return `You are the quality gate of a reference-faithful product photo edit. Image 1 is the authoritative source photograph of a jewellery product. Image 2 is a generated re-photograph of the SAME product on a new studio scene.

The product was deliberately re-posed and re-staged: differences in pose, background, surface, lighting, crop, shadows and camera angle are CORRECT and are never failures. Judge one question only: is the product in Image 2 the exact product in Image 1?
${ledger}
Inspect closely and compare: the count of stones, beads, charms and strands; chain type and link gauge relative to the components; each component's shape and cut, including real asymmetries; stone colours; metal colour; how components attach (threaded on the chain vs dangling below it); the orientation of directional motifs; each component's proportions; and rendering artefacts (double shadows, ghost marks, kinked or merged chain runs, invented elements).

Failure codes, use ONLY these: ${CHECK_FAILURE_CODES.join(', ')}.

Return ONLY raw JSON, no markdown, exactly this shape:
{"verdict":"pass"|"fail","failures":[{"code":"<one code>","detail":"<one short factual sentence>"}]}

"pass" with an empty failures array when the product is faithfully reproduced. "fail" with one entry per distinct problem when it is not. Flag only what you can clearly see; when a detail is too small or blurred to compare, do not guess a failure.`
}

/**
 * Deterministic: codes are deduplicated and sorted into the canonical
 * CHECK_FAILURE_CODES order before their correction lines are appended, so the
 * same (base prompt, codes) always yields byte-identical retry text.
 */
export function retryPromptFor(
  basePrompt: string,
  codes: readonly CheckFailureCode[],
): string {
  const ordered = CHECK_FAILURE_CODES.filter((code) => codes.includes(code))
  if (ordered.length === 0) return basePrompt
  const lines = ordered.map((code) => `- ${CORRECTION_LINES[code]}`).join('\n')
  return `${basePrompt}\n\nRENDER CORRECTIONS — a previous attempt failed verification against the source photograph on exactly these points. Fix each one; change nothing else about the product:\n${lines}`
}

export function parseCheckCodes(raw: string): readonly CheckFailureCode[] {
  return CHECK_FAILURE_CODES.filter((code) =>
    raw.split(',').map((part) => part.trim()).includes(code),
  )
}

export function serialiseCheckCodes(codes: readonly CheckFailureCode[]): string {
  return CHECK_FAILURE_CODES.filter((code) => codes.includes(code)).join(',')
}

interface RawVerdict {
  verdict?: unknown
  failures?: unknown
}

/**
 * Strict parse of the checker's JSON. Tolerates a fenced code block (some
 * models wrap JSON despite instructions) but nothing looser: an unparseable
 * verdict is a checker failure, which the worker treats as fail-open.
 */
export function parseCheckVerdict(raw: string): CheckVerdict {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
  let parsed: RawVerdict
  try {
    parsed = JSON.parse(trimmed) as RawVerdict
  } catch (error) {
    throw new EnhancementError('The render checker returned malformed JSON.', {
      stage: 'check',
      code: 'check_malformed_json',
      retryable: false,
      detail: { raw: raw.slice(0, 4_000), error: String(error) },
    })
  }

  if (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') {
    throw new EnhancementError('The render checker returned an unknown verdict.', {
      stage: 'check',
      code: 'check_unknown_verdict',
      retryable: false,
      detail: { raw: raw.slice(0, 4_000) },
    })
  }

  const failures = Array.isArray(parsed.failures)
    ? parsed.failures.flatMap((entry) => {
        const record = entry as { code?: unknown; detail?: unknown }
        const code = CHECK_FAILURE_CODES.find((known) => known === record.code)
        if (!code) return []
        return [{ code, detail: typeof record.detail === 'string' ? record.detail : '' }]
      })
    : []

  // A "fail" that names no recognisable failure gives the retry nothing to
  // correct; treat it as a checker fault rather than burning a regeneration.
  if (parsed.verdict === 'fail' && failures.length === 0) {
    throw new EnhancementError('The render checker failed the image without a usable code.', {
      stage: 'check',
      code: 'check_fail_without_codes',
      retryable: false,
      detail: { raw: raw.slice(0, 4_000) },
    })
  }

  return { pass: parsed.verdict === 'pass', failures }
}
