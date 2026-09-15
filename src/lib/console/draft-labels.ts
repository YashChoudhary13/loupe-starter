import 'server-only'
import type { Operator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { searchLabelVariants, type LabelVariant } from '@/lib/labels/catalogue'
import { draftLabelCopies, type DraftLabelOffer } from '@/lib/labels/draft-print'
import { supabaseServer } from '@/lib/supabase/server'

export type { DraftLabelOffer }

function draftId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Open the drafted product from Console before printing labels.')
  }
  return value
}

export async function loadDraftLabelOffer(id: string): Promise<DraftLabelOffer | null> {
  const { data, error } = await supabaseServer()
    .from('product_drafts')
    .select('id, reserved_sku, shopify_product_id, labels_printed')
    .eq('id', draftId(id))
    .maybeSingle()
  if (error) throw new Error('Could not read this draft to print labels.')
  if (!data?.shopify_product_id || !data.reserved_sku) return null
  const variants: LabelVariant[] = await searchLabelVariants(new ShopifyClient(), data.reserved_sku)
  if (!variants.length) return null
  return {
    draftId: data.id,
    sku: data.reserved_sku,
    labelsPrinted: Boolean(data.labels_printed),
    items: variants.map(variant => ({
      id: variant.id,
      title: variant.title === 'Default Title' ? 'One option' : variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      copies: draftLabelCopies(Math.min(500, Math.max(0, Math.trunc(Number(variant.inventoryQuantity ?? 0)) || 0))),
    })),
  }
}

export async function markDraftLabelsPrinted(id: string, operator: Operator): Promise<void> {
  const db = supabaseServer()
  const { data, error } = await db
    .from('product_drafts')
    .update({ labels_printed: true })
    .eq('id', draftId(id))
    .not('shopify_product_id', 'is', null)
    .select('id')
    .maybeSingle()
  if (error || !data) throw new Error('Labels can be marked printed only after this product exists in Shopify.')
  await db.from('events').insert({
    entity_type: 'product_draft',
    entity_id: data.id,
    event: 'draft.labels_printed',
    detail: {},
    actor: operator.email,
  })
}
