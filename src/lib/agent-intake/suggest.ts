import type { AgentSuggest, AgentTag, VariantKind } from '@/lib/console/types'

/**
 * D142: what Claude may say about an image it delivers. Pure validation, no server
 * import, so the route test and the console can share it.
 */

export const AGENT_TAGS: readonly AgentTag[] = ['needs_review', 'ready', 'restock']
export const SUGGEST_MAX_BYTES = 4096
export const NOTE_MAX_LENGTH = 500
export const BATCH_MAX_LENGTH = 80
/** NK951, CB250, RS391-S-7, INJ038. */
export const SKU_PATTERN = /^[A-Z]{2,4}[0-9]{1,5}[A-Z0-9-]*$/

const MATERIALS = ['304', '316L', 'Brass'] as const
const VARIANT_KINDS: readonly VariantKind[] = ['none', 'colour', 'number', 'size', 'colour_size']

export class AgentInputError extends Error {}

export function parseAgentTag(raw: unknown): AgentTag {
  if (typeof raw === 'string' && (AGENT_TAGS as readonly string[]).includes(raw)) return raw as AgentTag
  throw new AgentInputError('tag must be needs_review, ready or restock.')
}

export function parseRestockSku(raw: unknown, tag: AgentTag): string | null {
  const sku = typeof raw === 'string' ? raw.trim() : ''
  if (!sku) {
    if (tag === 'restock') throw new AgentInputError('A restock needs restock_sku.')
    return null
  }
  if (!SKU_PATTERN.test(sku)) throw new AgentInputError('restock_sku must look like NK951 or RS391-S-7.')
  return sku
}

export function parseNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new AgentInputError('note must be text.')
  const note = raw.trim()
  if (note.length > NOTE_MAX_LENGTH) throw new AgentInputError(`note is longer than ${NOTE_MAX_LENGTH} characters.`)
  return note || null
}

export function parseBatch(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new AgentInputError('batch must be text.')
  const batch = raw.trim()
  if (batch.length > BATCH_MAX_LENGTH) throw new AgentInputError(`batch is longer than ${BATCH_MAX_LENGTH} characters.`)
  return batch || null
}

function optionalInt(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AgentInputError(`suggest.${name} must be a whole number.`)
  return value as number
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new AgentInputError(`suggest.${name} must be text.`)
  const text = value.trim()
  if (text.length > max) throw new AgentInputError(`suggest.${name} is longer than ${max} characters.`)
  return text || null
}

/** `suggest` arrives as a JSON string in the multipart form. Unknown keys are dropped, wrong types refused. */
export function parseAgentSuggest(raw: unknown): AgentSuggest | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new AgentInputError('suggest must be a JSON string.')
  if (raw.length > SUGGEST_MAX_BYTES) throw new AgentInputError(`suggest is larger than ${SUGGEST_MAX_BYTES} bytes.`)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new AgentInputError('suggest is not valid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentInputError('suggest must be a JSON object.')
  const s = value as Record<string, unknown>

  const material = s.material === undefined || s.material === null ? null : s.material
  if (material !== null && !(MATERIALS as readonly unknown[]).includes(material)) {
    throw new AgentInputError('suggest.material must be 304, 316L or Brass.')
  }
  const variantKind = s.variant_kind === undefined || s.variant_kind === null ? null : s.variant_kind
  if (variantKind !== null && !(VARIANT_KINDS as readonly unknown[]).includes(variantKind)) {
    throw new AgentInputError('suggest.variant_kind must be none, colour, number, size or colour_size.')
  }
  const colours = s.colours === undefined || s.colours === null ? [] : s.colours
  if (!Array.isArray(colours) || colours.some((c) => typeof c !== 'string' || !c.trim() || c.length > 40)) {
    throw new AgentInputError('suggest.colours must be a list of colour names.')
  }
  if (s.archive_old !== undefined && typeof s.archive_old !== 'boolean') {
    throw new AgentInputError('suggest.archive_old must be true or false.')
  }

  return {
    pricePaise: optionalInt(s.price_paise, 'price_paise'),
    material: material as AgentSuggest['material'],
    titleSuffix: optionalText(s.title_suffix, 'title_suffix', 60),
    variantKind: variantKind as VariantKind | null,
    colours: (colours as string[]).map((c) => c.trim()),
    oldHandle: optionalText(s.old_handle, 'old_handle', 120),
    oldStatus: optionalText(s.old_status, 'old_status', 20),
    available: optionalInt(s.available, 'available'),
    committed: optionalInt(s.committed, 'committed'),
    onHand: optionalInt(s.on_hand, 'on_hand'),
    archiveOld: s.archive_old === true,
  }
}

/** The jsonb column holds the camelCase shape above, exactly as validated. */
export function agentSuggestFromRow(value: unknown): AgentSuggest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const s = value as Partial<AgentSuggest>
  return {
    pricePaise: typeof s.pricePaise === 'number' ? s.pricePaise : null,
    material: s.material === '304' || s.material === '316L' || s.material === 'Brass' ? s.material : null,
    titleSuffix: typeof s.titleSuffix === 'string' ? s.titleSuffix : null,
    variantKind: typeof s.variantKind === 'string' && VARIANT_KINDS.includes(s.variantKind) ? s.variantKind : null,
    colours: Array.isArray(s.colours) ? s.colours.filter((c): c is string => typeof c === 'string') : [],
    oldHandle: typeof s.oldHandle === 'string' ? s.oldHandle : null,
    oldStatus: typeof s.oldStatus === 'string' ? s.oldStatus : null,
    available: typeof s.available === 'number' ? s.available : null,
    committed: typeof s.committed === 'number' ? s.committed : null,
    onHand: typeof s.onHand === 'number' ? s.onHand : null,
    archiveOld: s.archiveOld === true,
  }
}

export function agentTagFromRow(value: unknown): AgentTag | null {
  return typeof value === 'string' && (AGENT_TAGS as readonly string[]).includes(value) ? (value as AgentTag) : null
}
