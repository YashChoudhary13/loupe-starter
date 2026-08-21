import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { registerAfterPublish } from '@/lib/match/register'
import { ShopifyClient } from '@/lib/shopify/client'
import { shopifyConfig } from '@/lib/shopify/config'
import { readProductByHandle, type ProductReadback } from '@/lib/shopify/product-set'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * Notice when a draft was published from Shopify's own admin.
 *
 * Qimati's operators build a batch of 100-150 drafts and publish them together,
 * and some of that publishing happens in Shopify rather than in Loupe. Without
 * this, those products stayed "Draft" in Loupe forever: Tracking kept counting
 * them as outstanding work and their source photographs never reached
 * `published`, so Drive housekeeping and R2 retention never ran for them.
 *
 * Shopify is authoritative for drafts Loupe has already sent there: ACTIVE
 * promotes the Loupe draft to published, while a missing Shopify product
 * removes the Loupe draft and returns its photographs to Pending. A product
 * that Loupe considers published and Shopify reports as draft is still *drift*
 * and belongs to reconciliation, which reports it for a human (D54) rather
 * than quietly rewriting either side.
 *
 * Promotion goes through `mark_draft_published()` — the same function the
 * console's own publish uses — so the intake rows are published and colour
 * usage counted in exactly one transaction, identically to a Loupe publish.
 */

export interface PromotionResult {
  readonly checked: number
  readonly promoted: readonly { readonly draftId: string; readonly sku: string | null }[]
  readonly deleted: readonly { readonly draftId: string; readonly sku: string | null }[]
  readonly failures: readonly { readonly draftId: string; readonly reason: string }[]
}

export interface DraftReconciliationDependencies {
  readonly db?: SupabaseClient
  readonly shopify?: ShopifyClient
  readonly readProduct?: (
    client: ShopifyClient,
    handle: string,
  ) => Promise<ProductReadback | null>
}

interface DraftRow {
  id: string
  reserved_sku: string | null
  reserved_handle: string | null
  shopify_product_id: string | null
}

export async function promotePublishedInShopify(
  actor = 'cron:shopify-reconcile',
  dependencies: DraftReconciliationDependencies = {},
): Promise<PromotionResult> {
  const db = dependencies.db ?? supabaseServer()

  // Only drafts Loupe has actually put in Shopify can have been published
  // there. A draft with no product id has nothing to look up.
  const { data, error } = await db
    .from('product_drafts')
    .select('id, reserved_sku, reserved_handle, shopify_product_id')
    .in('status', ['assembling', 'failed'])
    .not('shopify_product_id', 'is', null)
    .not('reserved_handle', 'is', null)
    .limit(500)
  if (error) throw new Error(`Could not load Loupe drafts: ${error.message}`)

  const drafts = (data ?? []) as DraftRow[]
  if (drafts.length === 0) return { checked: 0, promoted: [], deleted: [], failures: [] }

  const shopify =
    dependencies.shopify ?? new ShopifyClient({ config: shopifyConfig() })
  const readProduct = dependencies.readProduct ?? readProductByHandle
  const promoted: { draftId: string; sku: string | null }[] = []
  const deleted: { draftId: string; sku: string | null }[] = []
  const failures: { draftId: string; reason: string }[] = []

  for (const draft of drafts) {
    try {
      const product = await readProduct(shopify, draft.reserved_handle!)
      if (!product) {
        const { data: removed, error: removeError } = await db.rpc(
          'delete_shopify_missing_draft',
          {
            p_draft_id: draft.id,
            p_expected_shopify_product_id: draft.shopify_product_id,
            p_actor: actor,
          },
        )
        if (removeError) {
          failures.push({ draftId: draft.id, reason: removeError.message })
        } else if (removed === true) {
          deleted.push({ draftId: draft.id, sku: draft.reserved_sku })
        }
        continue
      }
      if (product.status !== 'ACTIVE') continue

      const { error: markError } = await db.rpc('mark_draft_published', {
        p_draft_id: draft.id,
        p_shopify_product_id: draft.shopify_product_id,
        p_actor: actor,
      })
      if (markError) {
        failures.push({ draftId: draft.id, reason: markError.message })
        continue
      }
      promoted.push({ draftId: draft.id, sku: draft.reserved_sku })
    } catch (cause) {
      failures.push({
        draftId: draft.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  // D111: products published from Shopify admin get their originals registered too.
  if (promoted.length > 0) await registerAfterPublish(db, actor)

  return { checked: drafts.length, promoted, deleted, failures }
}
