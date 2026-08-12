/**
 * D102 — the pieces of the webhook channel that must never be wrong:
 * signature verification (the trust boundary) and SKU parsing (what raises
 * counters). Handlers themselves are thin orchestration over functions proved
 * elsewhere (raise_sku_counter, delete_shopify_missing_draft, the comparator).
 */
import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  parseWebhookSku,
  productGid,
  verifyShopifyWebhookHmac,
} from '@/lib/shopify/webhook-verify'

function sign(body: string): string {
  return createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET!.trim())
    .update(body, 'utf8')
    .digest('base64')
}

describe('webhook HMAC verification', () => {
  const body = JSON.stringify({ id: 42, title: 'Necklace 970' })

  it('accepts the exact signature Shopify would send', () => {
    expect(verifyShopifyWebhookHmac(body, sign(body))).toBe(true)
  })

  it('rejects a tampered body, a wrong signature and a missing header', () => {
    expect(verifyShopifyWebhookHmac(body + ' ', sign(body))).toBe(false)
    expect(verifyShopifyWebhookHmac(body, sign('other'))).toBe(false)
    expect(verifyShopifyWebhookHmac(body, null)).toBe(false)
    expect(verifyShopifyWebhookHmac(body, 'not-base64-of-anything')).toBe(false)
  })
})

describe('webhook SKU parsing', () => {
  it('reads real catalogue shapes, zero-padded and long', () => {
    expect(parseWebhookSku('NK970')).toEqual({ prefix: 'NK', number: 970 })
    expect(parseWebhookSku('NP004')).toEqual({ prefix: 'NP', number: 4 })
    expect(parseWebhookSku('INJ012')).toEqual({ prefix: 'INJ', number: 12 })
    expect(parseWebhookSku(' NK1000 ')).toEqual({ prefix: 'NK', number: 1000 })
  })

  it('refuses shapes that are not Loupe SKUs', () => {
    for (const bad of ['', null, undefined, 'nk970', 'NK', '970', 'N970', 'TOOLONG123', 'NK97a']) {
      expect(parseWebhookSku(bad)).toBeNull()
    }
  })
})

describe('product gid resolution', () => {
  it('prefers the graphql id and falls back to the numeric REST id', () => {
    expect(productGid({ admin_graphql_api_id: 'gid://shopify/Product/7', id: 7 })).toBe(
      'gid://shopify/Product/7',
    )
    expect(productGid({ id: 7 })).toBe('gid://shopify/Product/7')
    expect(productGid({})).toBeNull()
  })
})
