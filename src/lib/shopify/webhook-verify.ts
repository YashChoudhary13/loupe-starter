/**
 * The pure half of the webhook channel (D102): signature verification and
 * payload parsing. Like config.ts, deliberately NOT `server-only` so the
 * trust boundary is provable from plain-Node tests; nothing here touches a
 * database or the network.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

import { malformedSkuCorrection } from '@/lib/publish/identity'

import { shopifyConfig } from './config'

export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false
  const digest = createHmac('sha256', shopifyConfig().clientSecret)
    .update(rawBody, 'utf8')
    .digest('base64')
  const expected = Buffer.from(digest)
  const provided = Buffer.from(hmacHeader)
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

export interface ProductWebhookPayload {
  readonly id?: number | string
  readonly admin_graphql_api_id?: string
  readonly handle?: string
  readonly title?: string
  readonly status?: string
  readonly variants?: readonly { readonly sku?: string | null }[]
}

export function productGid(payload: ProductWebhookPayload): string | null {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id
  if (payload.id !== undefined && payload.id !== null) return `gid://shopify/Product/${payload.id}`
  return null
}

/**
 * `NK1007` → { prefix: 'NK', number: 1007 }. Anything else → null.
 * Known catalogue typos also return null, matching the full Shopify scan.
 */
export function parseWebhookSku(sku: string | null | undefined): {
  prefix: string
  number: number
} | null {
  if (malformedSkuCorrection(sku)) return null
  const match = /^([A-Z]{2,4})0*([0-9]{1,9})$/u.exec(sku?.trim() ?? '')
  if (!match) return null
  return { prefix: match[1]!, number: Number(match[2]) }
}
