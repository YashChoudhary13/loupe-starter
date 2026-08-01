export const PRESENTATION_CLASSES = [
  'pair-upright',
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
  'pair-upright': `Show both pieces upright and front-facing, evenly spaced and symmetrically arranged
side by side at identical scale and height. Balanced, not mechanically duplicated.`,
  'flat-curve': `Lay the piece flat in a soft open curve, the pendant or centre feature toward the
lower centre of the frame and the chain sweeping naturally above it. Clasp visible.`,
  'standing-three-quarter': `Stand the piece on its band, tilted to a gentle three-quarter angle so both the face
and the profile of the band are readable. Do not lay it flat.`,
  'angled-band': `Rest the piece at a slight angle with its opening turned toward the camera, so the
width and inner face of the band are both visible.`,
  'flat-arc': `Lay the piece flat in a relaxed open arc, clasp and extender chain visible and
naturally placed rather than tucked away.`,
  'tray-grid': `Keep every item visible and evenly spaced in aligned rows at consistent scale, the
whole set square to the frame. Do not crop any item. Do not restage into a scene.`,
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
  if (words < 60 || words > 100) {
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
