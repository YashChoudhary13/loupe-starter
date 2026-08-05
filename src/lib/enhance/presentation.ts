export const PRESENTATION_CLASSES = [
  'pair-upright',
  'necklace-pendant',
  'necklace-station',
  'necklace-multistrand',
  'necklace-lariat',
  'flat-curve',
  'standing-three-quarter',
  'angled-band',
  'flat-arc',
  'tray-grid',
] as const

export type PresentationClass = (typeof PRESENTATION_CLASSES)[number]

export const FALLBACK_PRESENTATION_CLASS: PresentationClass = 'flat-curve'

const PRESENTATION_CLASS_SET = new Set<string>(PRESENTATION_CLASSES)

const COMPOSITION_DETAILS = {
  'pair-upright': `Show the exact source pieces upright and face-readable, side by side at their original
relative scale. Preserve the source item count and all pair differences; never create one piece by
duplicating or mirroring the other. Use one close, balanced macro retail crop that makes the design and
real differences readable without cutting either piece or selectively enlarging one.`,
  'necklace-pendant': `Arrange the same necklace as a compact, graceful oval or soft teardrop rather than
a long narrow measuring loop. If the source includes a real clasp or closure, fasten the two real ends
using only that visible hardware and keep the clasp, extender and terminal tag together near the top; if
no closure is visible, preserve the visible open topology and invent nothing. Rest the exact primary
pendant face-readable at the lower visual centre with its attachment naturally aligned. Keep every
decorative component and distinctive fitting visible. Any zoom applies uniformly to the whole piece;
never enlarge the pendant or stones independently.`,
  'necklace-station': `Arrange the same station or charm necklace as a broad closed oval or soft teardrop
when the source includes real closure hardware; fasten only the two real ends and keep the clasp, extender
and terminal tag together near the top. If the source is genuinely open or no closure is visible, preserve
that exact topology instead of inventing a closure. Keep every station on the continuous chain: the chain
must not terminate in a station, charm or bare cut end. Preserve exact component count, order, side
placement, mounting, orientation and relative spacing. Make the decorated run prominent and readable at
storefront-thumbnail size without selectively enlarging any component.`,
  'necklace-multistrand': `Arrange the same multi-strand necklace as a shallow layered crescent or broad
soft U, with its real joined ends or end caps close together near the top. Close it only through closure
hardware visible in the source; otherwise invent no clasp. Count the distinct parallel strands in the
source and reproduce exactly that many with their real end connections, nesting order, chain construction
and relative lengths. Separate the strands only enough to read them; never merge, remove, braid, fan,
stretch or substitute a plainer chain. Magnify every strand uniformly.`,
  'necklace-lariat': `Preserve the exact open lariat or Y topology. Place its real junction in the visual
centre or lower third and let the exact drop fall in one intentional straight or gently curving direction.
Do not close it into an oval necklace, relocate the junction, shorten the drop or redistribute motifs. Use
a close crop that makes the junction and drop readable while applying one uniform optical scale to the piece.`,
  'flat-curve': `This is the legacy fallback for a flexible necklace or long chain. First follow the
construction visible in the source: use a compact pendant layout for one dominant pendant, a broad relaxed
closed curve for spaced stations when real closure hardware is visible, a shallow layered crescent for
multiple joined strands, or the exact open Y topology for a lariat. Otherwise preserve the visible open or
closed construction in a compact graceful curve. Keep exact component order, side placement, spacing,
connections and hardware. Never create a new free end or terminate chain in a decorative element. Use one
uniform optical zoom; never enlarge an individual pendant, stone, charm or strand.`,
  'standing-three-quarter': `Stand the same piece on its band at a gentle three-quarter angle only as
far as the source supports. Preserve the exact face, profile, setting, band thickness and proportions;
do not invent an unseen side or lay it flat.`,
  'angled-band': `Rest the same piece at a slight angle with its opening toward the camera. Preserve the
exact width, inner face, closures, terminals, component count and proportions; do not complete,
mirror or regularise details that are unclear in the source.`,
  'flat-arc': `Lay the same flexible bracelet or anklet in a relaxed compact arc, or fasten it into one
continuous loop only when the source visibly includes the required closure hardware. Preserve its exact
strand count, chain topology, component sequence, spacing, clasp count, extender count and terminal tags;
do not invent a closure or add, remove, duplicate or redistribute any component.`,
  'tray-grid': `Keep the exact source item count visible in aligned rows at their original relative
scale and in the same sequence. Do not crop, duplicate, mirror, omit or redesign any item, and do not
restage the set into a scene.`,
} as const satisfies Record<PresentationClass, string>

export type StructuredDescriptionFailureReason =
  | 'invalid_json'
  | 'root_not_object'
  | 'unexpected_fields'
  | 'description_missing'
  | 'description_not_string'
  | 'description_blank'
  | 'description_not_one_paragraph'
  | 'description_word_count'
  | 'presentation_missing'
  | 'presentation_not_string'
  | 'presentation_invalid'

export class StructuredDescriptionError extends Error {
  constructor(
    readonly reason: StructuredDescriptionFailureReason,
    readonly rawResult: string,
  ) {
    super(`Invalid structured description output: ${reason}.`)
    this.name = 'StructuredDescriptionError'
  }
}

export interface StructuredDescription {
  readonly description: string
  readonly presentation: PresentationClass
}

function fail(
  reason: StructuredDescriptionFailureReason,
  rawResult: string,
): never {
  throw new StructuredDescriptionError(reason, rawResult)
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length
}

/**
 * Some otherwise-compliant chat models wrap their JSON response in a Markdown
 * code fence. Accept one fence only when it encloses the entire response; this
 * keeps surrounding prose and every other structured-output check strict.
 */
function jsonPayload(rawResult: string): string {
  const trimmed = rawResult.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  return fenced?.[1]?.trim() ?? rawResult
}

export function isPresentationClass(value: string): value is PresentationClass {
  return PRESENTATION_CLASS_SET.has(value)
}

export function compositionDetailFor(
  presentationClass: PresentationClass,
): string {
  return COMPOSITION_DETAILS[presentationClass]
}

export function parseStructuredDescription(rawResult: string): StructuredDescription {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonPayload(rawResult)) as unknown
  } catch {
    return fail('invalid_json', rawResult)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('root_not_object', rawResult)
  }

  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'description' || keys[1] !== 'presentation') {
    if (!Object.hasOwn(record, 'description')) {
      return fail('description_missing', rawResult)
    }
    if (!Object.hasOwn(record, 'presentation')) {
      return fail('presentation_missing', rawResult)
    }
    return fail('unexpected_fields', rawResult)
  }

  if (typeof record.description !== 'string') {
    return fail('description_not_string', rawResult)
  }
  const description = record.description.trim()
  if (!description) {
    return fail('description_blank', rawResult)
  }
  if (/[\r\n]/u.test(description)) {
    return fail('description_not_one_paragraph', rawResult)
  }
  const words = wordCount(description)
  if (words < 80 || words > 200) {
    return fail('description_word_count', rawResult)
  }

  if (typeof record.presentation !== 'string') {
    return fail('presentation_not_string', rawResult)
  }
  if (!isPresentationClass(record.presentation)) {
    return fail('presentation_invalid', rawResult)
  }

  return {
    description,
    presentation: record.presentation,
  }
}
