import 'server-only'

import { reconcileSingleProduct } from '@/lib/reconciliation/server'
import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

import { ShopifyClient } from './client'
import { parseWebhookSku, productGid, type ProductWebhookPayload } from './webhook-verify'

/**
 * D102 — Shopify tells Loupe the moment something changes, instead of the
 * operator trusting a 03:00 sweep.
 *
 * Three topics, three jobs:
 *
 *   products/create   Somebody made a product by hand in admin. Its SKUs raise
 *                     the per-prefix counters IMMEDIATELY (monotone
 *                     raise_sku_counter), which closes the NK1007 window — the
 *                     collision that previously waited for the nightly scan or
 *                     a publish-time probe.
 *   products/update   Same counter safety (a hand-edited SKU is a create by
 *                     another name). If the product is one Loupe PUBLISHED,
 *                     run the one-product reconciliation and keep exactly one
 *                     live alert per finding; a clean read-back auto-resolves.
 *                     Edits to DRAFT-stage products are the business finishing
 *                     listings (D90) and stay silent.
 *   products/delete   A deleted DRAFT-stage product releases its Loupe draft:
 *                     the same delete_shopify_missing_draft path the nightly
 *                     promotion uses, so photographs return to Pending within
 *                     seconds. Deleting a PUBLISHED product raises an alert —
 *                     that is retail damage a human must see.
 *
 * Handlers are idempotent: counters are monotone, the alert index is unique
 * per (product, code), and draft deletion double-checks the recorded id.
 */

const WEBHOOK_PATH = '/api/webhooks/shopify'
const TOPICS = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE'] as const

/**
 * Raise counters for every recognised SKU in the payload. Monotone by
 * construction — raise_sku_counter never lowers and unknown prefixes are
 * skipped rather than invented (same contract as the nightly counter sync).
 */
async function raiseCountersFromPayload(
  payload: ProductWebhookPayload,
  topic: string,
): Promise<void> {
  const db = supabaseServer()
  const parsed = (payload.variants ?? [])
    .map((variant) => parseWebhookSku(variant.sku))
    .filter((value): value is { prefix: string; number: number } => value !== null)
  if (parsed.length === 0) return

  const { data: prefixes } = await db.from('sku_counters').select('sku_prefix, last_number')
  const known = new Map(
    ((prefixes ?? []) as { sku_prefix: string; last_number: number }[]).map((row) => [
      row.sku_prefix,
      row.last_number,
    ]),
  )

  for (const { prefix, number } of parsed) {
    const current = known.get(prefix)
    if (current === undefined || number <= current) continue
    const { error } = await db.rpc('raise_sku_counter', { p_prefix: prefix, p_to: number })
    if (!error) {
      await db.from('events').insert({
        entity_type: 'system',
        entity_id: null,
        event: 'webhook.sku_counter_raised',
        detail: {
          topic,
          sku_prefix: prefix,
          raised_to: number,
          was: current,
          shopify_product_id: productGid(payload),
        },
        actor: 'shopify-webhook',
      })
    }
  }
}

async function raiseAlert(input: {
  shopifyProductId: string
  productDraftId: string | null
  topic: string
  code: string
  message: string
  detail?: unknown
}): Promise<void> {
  const db = supabaseServer()
  const { error } = await db.from('shopify_webhook_alerts').upsert(
    {
      shopify_product_id: input.shopifyProductId,
      product_draft_id: input.productDraftId,
      topic: input.topic,
      code: input.code,
      message: input.message.slice(0, 1_000),
      detail: input.detail ?? {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'shopify_product_id,code', ignoreDuplicates: false },
  )
  if (error) console.error('webhook alert upsert failed:', error.message)
}

async function resolveAlerts(shopifyProductId: string, resolvedBy: string): Promise<void> {
  const db = supabaseServer()
  await db
    .from('shopify_webhook_alerts')
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
    .eq('shopify_product_id', shopifyProductId)
    .is('resolved_at', null)
}

export async function handleProductsCreate(payload: ProductWebhookPayload): Promise<void> {
  await raiseCountersFromPayload(payload, 'products/create')
}

export async function handleProductsUpdate(payload: ProductWebhookPayload): Promise<void> {
  await raiseCountersFromPayload(payload, 'products/update')

  const gid = productGid(payload)
  if (!gid) return
  const db = supabaseServer()
  const { data: draft } = await db
    .from('product_drafts')
    .select('id, status')
    .eq('shopify_product_id', gid)
    .maybeSingle<{ id: string; status: string }>()
  // Not Loupe's, or still the business finishing a draft listing (D90).
  if (!draft || draft.status !== 'published') return

  try {
    const issues = await reconcileSingleProduct(db, new ShopifyClient(), draft.id)
    if (issues.length === 0) {
      await resolveAlerts(gid, 'webhook:clean-update')
      return
    }
    for (const found of issues) {
      await raiseAlert({
        shopifyProductId: gid,
        productDraftId: draft.id,
        topic: 'products/update',
        code: `${found.code}:${found.field}`,
        message: found.message,
        detail: { expected: found.expected, actual: found.actual },
      })
    }
  } catch (cause) {
    // A read-back hiccup must not bounce the webhook into Shopify's retry
    // storm; the nightly run remains the backstop.
    console.error('webhook single-product reconcile failed:', cause)
  }
}

export async function handleProductsDelete(payload: ProductWebhookPayload): Promise<void> {
  const gid = productGid(payload)
  if (!gid) return
  const db = supabaseServer()
  const { data: draft } = await db
    .from('product_drafts')
    .select('id, status, reserved_sku')
    .eq('shopify_product_id', gid)
    .maybeSingle<{ id: string; status: string; reserved_sku: string | null }>()
  if (!draft) return

  if (draft.status === 'published') {
    await raiseAlert({
      shopifyProductId: gid,
      productDraftId: draft.id,
      topic: 'products/delete',
      code: 'published_product_deleted',
      message: `${draft.reserved_sku ?? 'A published product'} was deleted in Shopify admin. Its number is spent and the listing is gone from the store.`,
    })
    return
  }

  // Same guarded path the nightly promotion uses: verifies the recorded id,
  // returns photographs to Pending, never lowers a counter.
  const { error } = await db.rpc('delete_shopify_missing_draft', {
    p_draft_id: draft.id,
    p_expected_shopify_product_id: gid,
    p_actor: 'shopify-webhook',
  })
  if (error) console.error('webhook draft release failed:', error.message)
}

/**
 * Idempotent registration, run from the nightly cron and the manual Full
 * reconciliation button. Creating a subscription that already exists is
 * skipped by comparing topic + callback.
 */
export async function ensureShopifyWebhooks(): Promise<{
  readonly ensured: readonly string[]
  readonly created: readonly string[]
}> {
  const callbackUrl = `${serverEnv.cronBaseUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`
  const client = new ShopifyClient()

  const existing = await client.graphql<{
    webhookSubscriptions: {
      nodes: readonly {
        topic: string
        endpoint: { __typename: string; callbackUrl?: string }
      }[]
    }
  }>(
    `query LoupeWebhookSubscriptions {
      webhookSubscriptions(first: 50) {
        nodes {
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }`,
    {},
  )

  const have = new Set(
    existing.webhookSubscriptions.nodes
      .filter((node) => node.endpoint.callbackUrl === callbackUrl)
      .map((node) => node.topic),
  )

  const created: string[] = []
  for (const topic of TOPICS) {
    if (have.has(topic)) continue
    const result = await client.graphql<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string } | null
        userErrors: readonly { message: string }[]
      }
    }>(
      `mutation LoupeWebhookCreate($topic: WebhookSubscriptionTopic!, $url: URL!) {
        webhookSubscriptionCreate(
          topic: $topic
          webhookSubscription: { callbackUrl: $url, format: JSON }
        ) {
          webhookSubscription { id }
          userErrors { message }
        }
      }`,
      { topic, url: callbackUrl },
    )
    const errors = result.webhookSubscriptionCreate.userErrors
    if (errors.length > 0) {
      throw new Error(`webhookSubscriptionCreate ${topic}: ${errors.map((e) => e.message).join('; ')}`)
    }
    created.push(topic)
  }
  return { ensured: [...TOPICS], created }
}
