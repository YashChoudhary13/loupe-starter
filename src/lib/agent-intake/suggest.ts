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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** D145: the supplier photograph's filename inside the batch, so the delivery remembers its source. */
export function parseSourceFilename(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new AgentInputError('source_filename must be text.')
  const name = raw.trim()
  if (name.length > 200) throw new AgentInputError('source_filename is longer than 200 characters.')
  return name || null
}

/** D145: the intake row this upload replaces (a redo). */
export function parseReplaces(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !UUID.test(raw.trim())) throw new AgentInputError('replaces must be an intake id (UUID).')
  return raw.trim().toLowerCase()
}

export function parseBatch(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new AgentInputError('batch must be text.')
  const batch = raw.trim()
  if (batch.length > BATCH_MAX_LENGTH) throw new AgentInputError(`batch is longer than ${BATCH_MAX_LENGTH} characters.`)
  return batch || null
}

/** Shopify counts an oversold listing below zero (RS380 stood at -40 after one 40-piece order), so stock may be negative; a price may not. */
const OVERSOLD = Number.MIN_SAFE_INTEGER

function optionalInt(value: unknown, name: string, min = 0): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new AgentInputError(`suggest.${name} must be a whole number.`)
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
  const alsoArchive = s.also_archive === undefined || s.also_archive === null ? [] : s.also_archive
  if (!Array.isArray(alsoArchive) || alsoArchive.length > 8 || alsoArchive.some((sku) => typeof sku !== 'string' || !SKU_PATTERN.test(sku))) {
    throw new AgentInputError('suggest.also_archive must be a list of up to 8 SKUs.')
  }

  return {
    pricePaise: optionalInt(s.price_paise, 'price_paise'),
    material: material as AgentSuggest['material'],
    titleSuffix: optionalText(s.title_suffix, 'title_suffix', 60),
    variantKind: variantKind as VariantKind | null,
    colours: (colours as string[]).map((c) => c.trim()),
    oldHandle: optionalText(s.old_handle, 'old_handle', 120),
    oldStatus: optionalText(s.old_status, 'old_status', 20),
    available: optionalInt(s.available, 'available', OVERSOLD),
    committed: optionalInt(s.committed, 'committed', OVERSOLD),
    onHand: optionalInt(s.on_hand, 'on_hand', OVERSOLD),
    archiveOld: s.archive_old === true,
    alsoArchive: alsoArchive as string[],
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
    alsoArchive: Array.isArray(s.alsoArchive) ? s.alsoArchive.filter((sku): sku is string => typeof sku === 'string' && SKU_PATTERN.test(sku)) : [],
  }
}

export function agentTagFromRow(value: unknown): AgentTag | null {
  return typeof value === 'string' && (AGENT_TAGS as readonly string[]).includes(value) ? (value as AgentTag) : null
}

/** D148: one old listing Claude puts beside a phone photograph it believes (or suspects) is a restock. */
export interface RestockCandidate {
  readonly sku: string
  readonly handle: string
  readonly title: string | null
  /** Always on Shopify's CDN: the browser shows it, and "Use old image" fetches it. */
  readonly imageUrl: string | null
  readonly status: string | null
  readonly available: number | null
  readonly pricePaise: number | null
  readonly createdAt: string | null
  readonly suggest: AgentSuggest | null
}

export interface RestockPayload {
  /** old: Claude is sure, and several candidates are the same design under several SKUs. unsure: look-alikes. */
  readonly kind: 'old' | 'unsure'
  readonly note: string | null
  readonly candidates: readonly RestockCandidate[]
}

export const RESTOCK_MAX_CANDIDATES = 6
const SHOPIFY_CDN = 'https://cdn.shopify.com/'
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/

function candidateText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new AgentInputError(`candidate.${name} must be text.`)
  const text = value.trim()
  if (text.length > max) throw new AgentInputError(`candidate.${name} is longer than ${max} characters.`)
  return text || null
}

function candidateInt(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value)) throw new AgentInputError(`candidate.${name} must be a whole number.`)
  return value as number
}

/** The JSON body of POST /api/agent/restocks, minus batch and source_filename. Latest listing first. */
export function parseRestockPayload(body: Record<string, unknown>): RestockPayload {
  if (body.kind !== 'old' && body.kind !== 'unsure') throw new AgentInputError('kind must be old or unsure.')
  const raw = body.candidates === undefined || body.candidates === null ? [] : body.candidates
  if (!Array.isArray(raw) || raw.length > RESTOCK_MAX_CANDIDATES) throw new AgentInputError(`candidates must be a list of up to ${RESTOCK_MAX_CANDIDATES}.`)
  if (body.kind === 'old' && raw.length === 0) throw new AgentInputError('A restock needs at least one candidate.')
  const candidates = raw.map((value): RestockCandidate => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentInputError('Every candidate must be an object.')
    const c = value as Record<string, unknown>
    if (typeof c.sku !== 'string' || !SKU_PATTERN.test(c.sku)) throw new AgentInputError('candidate.sku must look like NK951 or RS391-S-7.')
    if (typeof c.handle !== 'string' || !HANDLE_PATTERN.test(c.handle)) throw new AgentInputError('candidate.handle must be a product handle.')
    const imageUrl = candidateText(c.image_url, 'image_url', 500)
    if (imageUrl !== null && !imageUrl.startsWith(SHOPIFY_CDN)) throw new AgentInputError(`candidate.image_url must start with ${SHOPIFY_CDN}`)
    return {
      sku: c.sku,
      handle: c.handle,
      title: candidateText(c.title, 'title', 200),
      imageUrl,
      status: candidateText(c.status, 'status', 20),
      available: candidateInt(c.available, 'available'),
      pricePaise: candidateInt(c.price_paise, 'price_paise'),
      createdAt: candidateText(c.created_at, 'created_at', 40),
      suggest: c.suggest === undefined || c.suggest === null ? null : parseAgentSuggest(JSON.stringify(c.suggest)),
    }
  })
  if (new Set(candidates.map((c) => c.sku)).size !== candidates.length) throw new AgentInputError('Two candidates carry the same SKU.')
  // Latest listing first: that is the one whose image is reused when the same design has several SKUs.
  candidates.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return { kind: body.kind, note: parseNote(body.note), candidates }
}

/** The jsonb column holds the shape above, exactly as validated; anything else reads as no candidate. */
export function restockPayloadFromRow(value: unknown): RestockPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as { kind?: unknown; note?: unknown; candidates?: unknown }
  if (row.kind !== 'old' && row.kind !== 'unsure') return null
  const candidates = (Array.isArray(row.candidates) ? row.candidates : []).flatMap((value): RestockCandidate[] => {
    const c = value as Partial<RestockCandidate> | null
    if (!c || typeof c.sku !== 'string' || typeof c.handle !== 'string') return []
    return [{
      sku: c.sku, handle: c.handle,
      title: typeof c.title === 'string' ? c.title : null,
      imageUrl: typeof c.imageUrl === 'string' && c.imageUrl.startsWith(SHOPIFY_CDN) ? c.imageUrl : null,
      status: typeof c.status === 'string' ? c.status : null,
      available: typeof c.available === 'number' ? c.available : null,
      pricePaise: typeof c.pricePaise === 'number' ? c.pricePaise : null,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
      suggest: agentSuggestFromRow(c.suggest),
    }]
  })
  return { kind: row.kind, note: typeof row.note === 'string' ? row.note : null, candidates }
}

/**
 * What an operator's choice means for the listing: which other SKUs of the same design go with the
 * chosen one, and what the Pending row says. Only a sure restock (`old`) carries the other SKUs;
 * for `unsure` the other candidates are look-alikes, not the same piece.
 */
export function restockChoice(payload: RestockPayload, sku: string): { chosen: RestockCandidate; others: readonly RestockCandidate[]; alsoArchive: string[]; note: string } | null {
  const chosen = payload.candidates.find((c) => c.sku === sku)
  if (!chosen) return null
  const others = payload.kind === 'old' ? payload.candidates.filter((c) => c !== chosen) : []
  const alsoArchive = others.filter((c) => c.status === 'ACTIVE' && c.available !== null && c.available <= 0).map((c) => c.sku)
  const stocked = [chosen, ...others].filter((c) => (c.available ?? 0) > 0)
  const lead = stocked.map((c) => `${c.sku} still has ${c.available} available`).join('; ')
  const note = [
    lead ? `${lead}: not archived on publish unless you switch it on.` : '',
    others.length > 0 ? `Same design also listed as ${others.map((c) => c.sku).join(', ')}.` : '',
    payload.note ?? '',
  ].filter(Boolean).join(' ').slice(0, NOTE_MAX_LENGTH)
  return { chosen, others, alsoArchive, note }
}
