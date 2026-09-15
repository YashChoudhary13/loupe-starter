import 'server-only'
import { type Operator } from '@/lib/auth/authorize'
import { supabaseServer } from '@/lib/supabase/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { findCodeMatches } from '@/lib/shopify/barcode-lookup'
import { readQcOrder } from '@/lib/shopify/qc-orders'
import { orderFingerprint } from './snapshot'
import type { QcCommand, QcEvent, QcSession, QcView } from './types'

/** Match across the catalogue, never only within the currently open order. */
export async function resolveQcCode(client: ShopifyClient, code: string): Promise<{ variantId: string | null; rejection: string | null }> {
  const matches = await findCodeMatches(client, code)
  const ids = [...new Set(matches.map(match => match.id))]
  if (ids.length === 0) return { variantId: null, rejection: 'Code not found in Shopify. Check the label and use Labels to prepare a saved barcode.' }
  if (ids.length > 1) return { variantId: null, rejection: 'This code belongs to several variants. Give each colour and size a unique code in Labels before QC.' }
  return { variantId: ids[0], rejection: null }
}

export async function loadQcView(orderId: string, operator: Operator, command?: QcCommand): Promise<QcView> {
  const client = new ShopifyClient()
  // Resolve first, so the order snapshot is fetched immediately before its transaction.
  const resolution = command?.action === 'scan' ? await resolveQcCode(client, command.code!) : { variantId: null, rejection: null }
  const order = await readQcOrder(client, orderId)
  const checkedAt = new Date().toISOString()
  const db = supabaseServer()
  const { data, error } = await db.rpc('qc_command', {
    p_shop_domain: client.config.storeDomain, p_order_id: order.id, p_actor_id: operator.id,
    p_action: command?.action ?? 'sync', p_snapshot: order, p_fingerprint: orderFingerprint(order), p_checked_at: checkedAt,
    p_request_id: command?.requestId ?? null, p_code: command?.code ?? null,
    p_variant_id: resolution.variantId, p_rejection: resolution.rejection,
    p_expected_generation: command?.expectedGeneration ?? null,
    p_expected_version: command?.expectedVersion ?? null, p_undo_event_id: command?.undoEventId ?? null,
    p_reason: command?.reason ?? null,
  })
  if (error) throw new Error(`QC could not save this action. Retry the same request. ${error.message}`)
  const result = data as { session: QcSession; event?: QcEvent; replayed?: boolean }
  if (!result?.session) throw new Error('QC did not return saved counts. Retry the same request before scanning another item.')
  const history = await db.from('qc_events').select('id,action,outcome,message,code,line_id,actor_id,actor_name,created_at,generation,undo_of')
    .eq('session_id', result.session.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(40)
  if (history.error) throw new Error('QC saved the action but could not read its history. Retry the same request; it will not count twice.')
  return { order, session: result.session, events: history.data as QcEvent[], operatorId: operator.id, event: result.event, replayed: result.replayed }
}

export async function qcOrderStatuses(orderIds: readonly string[]): Promise<Record<string, { status: string; checked_at: string; snapshotUpdatedAt: string }>> {
  if (!orderIds.length) return {}
  const client = new ShopifyClient()
  const { data, error } = await supabaseServer().from('qc_sessions').select('order_id,status,checked_at,snapshot')
    .eq('shop_domain', client.config.storeDomain).in('order_id', [...orderIds])
  if (error) throw new Error('QC progress could not be loaded. Open an order to retry.')
  return Object.fromEntries((data ?? []).map(row => [row.order_id, { status: row.status, checked_at: row.checked_at, snapshotUpdatedAt: row.snapshot?.updatedAt }]))
}
