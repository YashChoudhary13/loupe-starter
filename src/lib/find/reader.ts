import Anthropic from '@anthropic-ai/sdk'

import { cleanSticker, type SlipRead } from './query'

/**
 * Find (D173): reads one photograph of a packed parcel on the Claude API. The picture shows a packing slip (order
 * number as printed text, no barcode) and the courier's sticker. The answer is three small values; the server then
 * checks them against Shopify (`judgeRead`), so nothing here is trusted on its own.
 *
 * Measured on the 45 parcel photographs of 16 Nov 2026 (2576 px long edge): this model at low effort read 40 order
 * numbers right, none for 3 and a wrong one for 2; Sonnet 5.5, Opus 5.5 and medium effort did no better on the order
 * number, because the limit is the small print under shiny tape, not the model. Opus read every sticker right, this
 * model doubled a digit on 3 of 44.
 *
 * ponytail: the sticker is read by the model, not decoded from its barcode, so a digit can be wrong. Find never uses
 * it as the tracking number (Shopify is asked). Decode the barcode before anything fulfils from this value.
 */
export const READER_MODEL = 'claude-haiku-5-5'
export const READER_MIME = { 'image/jpeg': true, 'image/png': true, 'image/webp': true } as const
export type ReaderMime = keyof typeof READER_MIME

const PROMPT = [
  'This photograph shows a parcel packed at Qimati, a jewellery shop. It shows a printed packing slip and usually a courier sticker with a barcode.',
  'Report three things and nothing else.',
  '1. orders: the order number printed at the top right of the packing slip, after the word "Order" (for example "Order Qimati8524" is 8524). If the strip at the very top of the slip says CLUB followed by an arrow and other order numbers, add those numbers after it. Digits only. An empty list when no order number can be read.',
  '2. pincode: the six-digit PIN code in the "Ship to" address on the slip, or null.',
  '3. sticker: the consignment or tracking number on the courier sticker (the characters printed with its barcode), without spaces, or null when there is no sticker or it cannot be read.',
  'Never guess. A value with a character you cannot read clearly is null (an order number is left out). Do not report names, phone numbers or addresses.',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: {
    orders: { type: 'array', items: { type: 'integer' } },
    pincode: { type: ['string', 'null'] },
    sticker: { type: ['string', 'null'] },
  },
  required: ['orders', 'pincode', 'sticker'],
  additionalProperties: false,
} as const

export class UnreadableParcel extends Error {}

export interface ReaderInput { apiKey: string; workspaceId?: string; image: Buffer; mime: ReaderMime; model?: string; fetchImpl?: typeof fetch }

/** Throws `UnreadableParcel` (refused, cut off, or not the agreed shape) or the SDK's own error; the caller sends the photograph to a person either way. */
export async function readParcelPhoto(input: ReaderInput): Promise<SlipRead> {
  // A key that is not tied to one workspace must name its workspace on every call (same rule as the Home assistant, D149).
  // 30 s twice at worst: a reading takes about 2.5 s, and the upload's request must end well inside Cloudflare's 100 s.
  const client = new Anthropic({ apiKey: input.apiKey, fetch: input.fetchImpl, timeout: 30_000, maxRetries: 1, defaultHeaders: input.workspaceId ? { 'anthropic-workspace-id': input.workspaceId } : undefined })
  const reply = await client.messages.create({
    model: input.model ?? READER_MODEL,
    max_tokens: 4_000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: input.mime, data: input.image.toString('base64') } },
      { type: 'text', text: PROMPT },
    ] }],
  })
  if (reply.stop_reason !== 'end_turn') throw new UnreadableParcel(`The reader stopped with ${reply.stop_reason}.`)
  const text = reply.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map(block => block.text).join('')
  return parseRead(text)
}

/** The model's JSON as a `SlipRead`, with every value narrowed to what the rest of Find accepts. */
export function parseRead(text: string): SlipRead {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new UnreadableParcel('The reader did not answer in JSON.') }
  const value = raw as { orders?: unknown; pincode?: unknown; sticker?: unknown } | null
  if (!value || !Array.isArray(value.orders)) throw new UnreadableParcel('The reader left out the order list.')
  const pincode = typeof value.pincode === 'string' ? value.pincode.replace(/\D/g, '') : ''
  return {
    orders: value.orders.filter((n): n is number => Number.isSafeInteger(n) && n > 0 && n < 100_000_000),
    pincode: pincode.length === 6 ? pincode : null,
    sticker: cleanSticker(typeof value.sticker === 'string' ? value.sticker : null),
  }
}
