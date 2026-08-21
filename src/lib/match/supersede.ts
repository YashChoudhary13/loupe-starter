import type { SupabaseClient } from '@supabase/supabase-js'

import type { ShopifyClient } from '@/lib/shopify/client'
import { archiveProduct, readProductStockBySku, setAvailableQuantities } from '@/lib/shopify/inventory'

/**
 * D112: a draft created from a restock photograph on the "new SKU" path replaces
 * an existing product. Once the new product is live, the old one is archived and
 * its stock zeroed, so two active listings never carry the same piece. Runs
 * after mark_draft_published; a failure is recorded on the decision and shown
 * in Restock, never thrown into a publish that already happened.
 */
export async function supersedeAfterPublish(
  db: Pick<SupabaseClient, 'rpc'>,
  shopify: ShopifyClient,
  draftId: string,
  actor: string,
): Promise<{ superseded: string } | { none: true } | { error: string }> {
  const { data, error } = await db.rpc('pending_supersession', { p_draft_id: draftId })
  if (error) return { error: `pending_supersession: ${error.message}` }
  const pending = ((data ?? []) as { decision_id: string; old_sku: string; old_shopify_product_id: string | null }[])[0]
  if (!pending) return { none: true }

  try {
    let productId = pending.old_shopify_product_id
    let variants: { inventoryItemId: string; quantity: number }[] = []
    const products = await readProductStockBySku(shopify, pending.old_sku)
    const target = products.find((p) => p.productId === productId) ?? products.find((p) => p.status === 'ACTIVE') ?? products[0]
    if (target) {
      productId = target.productId
      variants = target.variants.map((v) => ({ inventoryItemId: v.inventoryItemId, quantity: 0 }))
    }
    if (!productId) throw new Error(`No Shopify product carries SKU ${pending.old_sku}; nothing to archive.`)

    await archiveProduct(shopify, productId)
    await setAvailableQuantities(shopify, variants, `loupe://supersession/${pending.decision_id}`)
    const { error: recordError } = await db.rpc('record_supersession', {
      p_draft_id: draftId,
      p_decision_id: pending.decision_id,
      p_old_product_id: productId,
      p_actor: actor,
    })
    if (recordError) throw new Error(`record_supersession: ${recordError.message}`)
    return { superseded: pending.old_sku }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error('supersession after publish failed:', message)
    await db.rpc('fail_restock', { p_decision_id: pending.decision_id, p_error: message, p_actor: actor })
    return { error: message }
  }
}
