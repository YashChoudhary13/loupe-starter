import { verifyShopifyWebhookHmac } from '@/lib/shopify/webhook-verify'
import {
  handleProductsCreate,
  handleProductsDelete,
  handleProductsUpdate,
} from '@/lib/shopify/webhooks'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Shopify → Loupe (D102). HMAC first — the raw body is verified against the
 * app client secret before anything is parsed, and a bad signature is a 401
 * with no detail. Handlers are small and idempotent, so the work runs inline
 * and Shopify gets its 200 well inside the 5-second budget; any handler
 * failure still returns 200 for a VERIFIED payload, because Shopify's retry
 * storm cannot fix a Loupe-side bug and the nightly reconciliation is the
 * backstop.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')
  if (!verifyShopifyWebhookHmac(rawBody, hmac)) {
    return new Response('unauthorized', { status: 401 })
  }

  const topic = request.headers.get('x-shopify-topic') ?? ''
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response('ok', { status: 200 })
  }

  try {
    if (topic === 'products/create') await handleProductsCreate(payload as never)
    else if (topic === 'products/update') await handleProductsUpdate(payload as never)
    else if (topic === 'products/delete') await handleProductsDelete(payload as never)
  } catch (cause) {
    console.error(`shopify webhook ${topic} failed:`, cause)
  }
  return new Response('ok', { status: 200 })
}

export function GET(): Response {
  return new Response('method not allowed', { status: 405 })
}
