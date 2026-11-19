import { createHash } from 'node:crypto'

import Anthropic from '@anthropic-ai/sdk'

import { FACETS, FREE_FIELDS, GUIDE, KINDS, LIST_FIELDS, PIECES, TAXONOMY_VERSION, TYPE_KINDS } from './vocabulary'

/**
 * Design labels (D177): Claude looks at a product's photos once and names its design in the store search's vocabulary.
 *
 * A port of the search project's `scripts/label.py` (`system_prompt`, `schema`, `product_text`, `kind_of`, `types_for`,
 * `clean`, the request in `label_one`), so a row written here is interchangeable with a row that script writes.
 * `tests/design-tags.test.ts` holds the two to the same strings through a fixture made by label.py itself
 * (`scripts/design-tags-sync.mjs`). Differences on purpose: the photos are sent as Loupe's 1280 px WebP previews
 * (label.py sends Shopify's own image addresses), and one retry instead of five.
 */
export const LABEL_MODEL = 'claude-opus-5-5'
export const LABEL_EFFORT = 'high'
export const MAX_PHOTOS = 4
export const DESIGN_LABELS_METAFIELD = { namespace: 'qimati', key: 'design_labels', type: 'json' } as const

/** US$ per million tokens: input, output, cache read; a cache write is 1.25 x input (label.py PRICE). */
const PRICE = { input: 4, output: 20, cacheRead: 0.2 }

export type Labels = Record<string, string | string[]>
export interface ProductFacts { readonly title: string; readonly options: readonly { name: string; values: readonly string[] }[] }

/** label.py `kind_of`: the first kind whose title pattern matches, else "other". */
export function kindOf(title: string): string {
  return Object.entries(KINDS).find(([, pattern]) => new RegExp(pattern, 'i').test(title))?.[0] ?? 'other'
}

/**
 * Loupe knows the category, so the kind comes from its SKU prefix; a category without one here falls back to the
 * title, as label.py does. INJ is the taxonomy's "mixed" kind (any piece, decided from the photos), which its titles
 * ("Indian Pendant Sets", the older "Indian Jewellery") also reach; a men's jewellery title reaches "mixed" through
 * the title alone.
 */
const KIND_BY_PREFIX: Readonly<Record<string, string>> = {
  NK: 'necklace', ER: 'earrings', BK: 'kada', CB: 'chain-bracelet', RS: 'ring', AK: 'anklet', NP: 'nose-pin',
  WH: 'watch', HC: 'hand-chain', HJ: 'hair', HA: 'hair', WC: 'waist-chain', INJ: 'mixed',
}
export function kindFor(skuPrefix: string | null, title: string): string {
  return (skuPrefix && KIND_BY_PREFIX[skuPrefix.toUpperCase()]) || kindOf(title)
}

/** label.py `types_for`: the types (with their definitions) that belong to any of the kinds. */
export function typesFor(kinds: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(FACETS.type).filter(([type]) => TYPE_KINDS[type].split(/\s+/).some((k) => kinds.includes(k))))
}

/** label.py `system_prompt`. */
export function systemPrompt(): string {
  const parts = [GUIDE, 'The labels']
  for (const [facet, values] of Object.entries(FACETS)) {
    if (facet !== 'type') parts.push(`\n${facet}\n` + Object.entries(values).map(([value, definition]) => `- ${value}: ${definition}`).join('\n'))
  }
  return parts.join('\n')
}

/** label.py `schema`: every list field limited to its facet's labels, every field required. */
export function schema() {
  const strings = (values?: readonly string[]) => ({ type: 'array', items: values ? { type: 'string', enum: [...values] } : { type: 'string' } })
  const props: Record<string, unknown> = { description: { type: 'string' }, pieces: strings(PIECES) }
  for (const [field, facet] of Object.entries(LIST_FIELDS)) props[field] = strings(Object.keys(FACETS[facet]))
  for (const field of FREE_FIELDS) props[field] = strings()
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false }
}

/** label.py `product_text`: the kind, title, options and allowed types, after the photos. */
export function productText(product: ProductFacts, kind: string): string {
  const types = typesFor(kind === 'mixed' ? PIECES : [kind])
  const lines = [
    'Kind: ' + (kind === 'mixed' ? "from a range that holds any kind of piece (Indian jewellery, men's jewellery): decide from the photos" : kind),
    'Title: ' + product.title,
    ...product.options.map((o) => `Option ${o.name}: ${o.values.join(', ')}`),
  ]
  lines.push('Types you may use: ' + (Object.entries(types).map(([t, d]) => `${t} (${d})`).join('; ') || 'none, leave types empty'))
  return lines.join('\n')
}

const unique = (values: readonly string[]) => [...new Set(values)]

/** label.py `clean`: only allowed labels, no repeats, nothing both main and secondary, free words trimmed and lowercase. */
export function clean(answer: Record<string, unknown>, kind: string): Labels {
  const list = (field: string) => {
    const value = answer[field]
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error(`The labeller's answer has no list "${field}".`)
    return value as string[]
  }
  if (typeof answer.description !== 'string') throw new Error('The labeller\'s answer has no description.')
  const out: Labels = { description: answer.description, pieces: unique(list('pieces')) }
  for (const field of Object.keys(LIST_FIELDS)) out[field] = unique(list(field))
  const okTypes = typesFor(kind === 'mixed' ? (out.pieces as string[]) : [kind])
  out.types = (out.types as string[]).filter((t) => t in okTypes)
  out.detail_motifs = (out.detail_motifs as string[]).filter((m) => !out.main_motifs.includes(m))
  out.accent_colours = (out.accent_colours as string[]).filter((c) => !out.main_colours.includes(c))
  for (const field of FREE_FIELDS) out[field] = unique(list(field).filter((w) => w.trim()).map((w) => w.trim().toLowerCase())).slice(0, 8)
  return out
}

/** The photos sent (image version ids, in order), the category and the vocabulary: the same three never label twice. */
export function fingerprint(imageVersionIds: readonly string[], skuPrefix: string | null): string {
  return createHash('sha256').update(JSON.stringify([imageVersionIds, skuPrefix ?? '', TAXONOMY_VERSION])).digest('hex')
}

/** The fingerprint a stored `qimati.design_labels` value was made for, or null for none or an unreadable value. */
export function storedFingerprint(value: string | null | undefined): string | null {
  try {
    const images = (JSON.parse(value ?? '') as { images?: unknown } | null)?.images
    return typeof images === 'string' ? images : null
  } catch { return null }
}

/** The metafield's JSON: the label row of label.py without id and handle, kind first. */
export function metafieldValue(labels: Labels, kind: string, print: string, at: Date, model = LABEL_MODEL) {
  return { v: 1, model, at: at.toISOString(), images: print, labels: { kind, ...labels } }
}

/** Built on the first call, not on import: a bad vocabulary breaks labelling only, never the console actions importing this. */
let request: { system: string; schema: ReturnType<typeof schema> } | null = null

export interface Usage { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number; readonly usd: number }

export interface LabelInput {
  readonly apiKey: string
  readonly workspaceId?: string
  /** WebP bytes, in publish order; at most MAX_PHOTOS are sent. */
  readonly photos: readonly Buffer[]
  readonly product: ProductFacts
  readonly kind: string
  readonly fetchImpl?: typeof fetch
}

/** One request, as label.py `label_one` makes it. Throws on a refusal, a cut-off answer or an answer of the wrong shape. */
export async function labelPhotos(input: LabelInput): Promise<{ labels: Labels; usage: Usage }> {
  // A key not tied to one workspace names its workspace on every call (D149). label.py allows 180 s per try.
  const asked = (request ??= { system: systemPrompt(), schema: schema() })
  const client = new Anthropic({ apiKey: input.apiKey, fetch: input.fetchImpl, timeout: 180_000, maxRetries: 1, defaultHeaders: input.workspaceId ? { 'anthropic-workspace-id': input.workspaceId } : undefined })
  const reply = await client.messages.create({
    model: LABEL_MODEL,
    max_tokens: 64_000,
    system: [{ type: 'text', text: asked.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [
      ...input.photos.slice(0, MAX_PHOTOS).map((photo) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/webp' as const, data: photo.toString('base64') } })),
      { type: 'text', text: productText(input.product, input.kind) },
    ] }],
    output_config: { effort: LABEL_EFFORT, format: { type: 'json_schema', schema: asked.schema } },
  })
  if (reply.stop_reason !== 'end_turn') throw new Error(`The labeller stopped with ${reply.stop_reason}.`)
  const text = reply.content.find((block): block is Anthropic.TextBlock => block.type === 'text')?.text ?? ''
  let answer: unknown
  try { answer = JSON.parse(text) } catch { throw new Error('The labeller did not answer in JSON.') }
  if (!answer || typeof answer !== 'object') throw new Error('The labeller did not answer with an object.')
  const u = reply.usage
  const usage = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens }
  const usd = (usage.input * PRICE.input + usage.cacheRead * PRICE.cacheRead + usage.cacheWrite * PRICE.input * 1.25 + usage.output * PRICE.output) / 1e6
  return { labels: clean(answer as Record<string, unknown>, input.kind), usage: { ...usage, usd: Math.round(usd * 10_000) / 10_000 } }
}
