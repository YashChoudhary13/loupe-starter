import 'server-only'

import type { Operator } from '@/lib/auth/authorize'
import { supabaseServer } from '@/lib/supabase/server'

import { publishDraftForOperator, PublishInProgressError } from './publish'

/**
 * The Shopify half of "Save draft", run after the response has been sent.
 *
 * D60 made Save draft also create the Shopify DRAFT product, which put a full
 * `productSet` round trip inside the operator's click and froze the console
 * for its duration. The local save is authoritative (the typing is in
 * Postgres before this runs); Shopify is the part that may fail, so it is the
 * part that moved off the click.
 *
 * Outcome visibility replaces the old inline error: success clears any stale
 * draft error and emits `draft.shopify_synced`; failure records the message on
 * the draft row and emits `draft.shopify_push_failed`. Both events are in the
 * live-heartbeat refresh lists, so the console updates the reserved SKU or
 * shows the amber notice without holding the operator's hands still.
 *
 * Idempotency and races lean on the existing machinery: `begin_draft_publish`
 * serialises concurrent pushes (a second push while one is in flight simply
 * yields), and a retry publishes by the same reserved handle (hard rule 2).
 */
export async function pushDraftToShopifyInBackground(
  draftId: string,
  operator: Operator,
  allowZeroStock: boolean,
): Promise<void> {
  const db = supabaseServer()
  try {
    await publishDraftForOperator(draftId, operator, {
      allowZeroStock,
      shopifyStatus: 'DRAFT',
    })
    await db
      .from('product_drafts')
      .update({ error: null })
      .eq('id', draftId)
      .eq('status', 'assembling')
    await db.from('events').insert({
      entity_type: 'product_draft',
      entity_id: draftId,
      event: 'draft.shopify_synced',
      detail: {},
      actor: operator.email,
    })
  } catch (cause) {
    // Another push already owns the publish lease; it will report its own
    // outcome. Recording this as a failure would be a false alarm.
    if (cause instanceof PublishInProgressError) return

    const message =
      cause instanceof Error ? cause.message : 'The draft could not be sent to Shopify.'
    // Best-effort, never throwing: this runs post-response with nobody to
    // report to except the tables themselves.
    await db
      .from('product_drafts')
      .update({ error: message.slice(0, 2_000) })
      .eq('id', draftId)
      .eq('status', 'assembling')
      .then(() => undefined, () => undefined)
    await db
      .from('events')
      .insert({
        entity_type: 'product_draft',
        entity_id: draftId,
        event: 'draft.shopify_push_failed',
        detail: { message: message.slice(0, 500) },
        actor: operator.email,
      })
      .then(() => undefined, () => undefined)
  }
}
