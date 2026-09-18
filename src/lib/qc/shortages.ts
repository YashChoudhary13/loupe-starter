import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { SHORTAGE_FIELDS } from './server'
import { QC_STAFF_RESOLUTIONS, type QcResolution, type QcShortage } from './types'

export interface ShortageLists { open: QcShortage[]; resolved: QcShortage[] }

/** Open shortages (oldest first) and those resolved in the last `days` (newest first). */
export async function listShortages(days = 30): Promise<ShortageLists> {
  const db = supabaseServer()
  const shop = new ShopifyClient().config.storeDomain
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const [open, resolved] = await Promise.all([
    db.from('qc_shortages').select(SHORTAGE_FIELDS).eq('shop_domain', shop).is('resolved_at', null).order('ref', { ascending: true }).limit(500),
    db.from('qc_shortages').select(SHORTAGE_FIELDS).eq('shop_domain', shop).gte('resolved_at', since).order('resolved_at', { ascending: false }).limit(500),
  ])
  if (open.error || resolved.error) throw new Error('Shortages could not be loaded.')
  return { open: open.data as QcShortage[], resolved: resolved.data as QcShortage[] }
}

export interface ResolveInput { ref: unknown; resolution: unknown; note?: unknown; by: string }

export function parseResolveInput(input: ResolveInput): { ref: number; resolution: QcResolution; note: string | null; by: string } {
  const ref = typeof input.ref === 'string' ? Number(input.ref.trim().replace(/^#/, '')) : input.ref
  if (!Number.isSafeInteger(ref) || Number(ref) < 1) throw new Error('Give the shortage number, for example 12.')
  const resolution = String(input.resolution ?? '').trim().toLowerCase()
  if (!(QC_STAFF_RESOLUTIONS as string[]).includes(resolution)) throw new Error(`Say how it was resolved: ${QC_STAFF_RESOLUTIONS.join(', ')}.`)
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 240) : ''
  const by = input.by.trim().slice(0, 80)
  if (!by) throw new Error('A resolver name is required.')
  return { ref: Number(ref), resolution: resolution as QcResolution, note: note || null, by }
}

/** Marks one open shortage resolved. Idempotent on an already-resolved row: returns it unchanged with `changed: false`. */
export async function resolveShortage(input: ResolveInput): Promise<{ shortage: QcShortage; changed: boolean }> {
  const { ref, resolution, note, by } = parseResolveInput(input)
  const db = supabaseServer()
  const shop = new ShopifyClient().config.storeDomain
  const existing = await db.from('qc_shortages').select(SHORTAGE_FIELDS).eq('shop_domain', shop).eq('ref', ref).maybeSingle()
  if (existing.error) throw new Error('Shortage could not be read.')
  if (!existing.data) throw new Error(`No shortage #${ref}.`)
  if (existing.data.resolved_at) return { shortage: existing.data as QcShortage, changed: false }
  // Conditional update: a second resolver racing on the same row changes nothing.
  const updated = await db.from('qc_shortages')
    .update({ resolved_at: new Date().toISOString(), resolved_by: by, resolution, resolution_note: note })
    .eq('id', existing.data.id).is('resolved_at', null).select(SHORTAGE_FIELDS).maybeSingle()
  if (updated.error) throw new Error('Shortage could not be updated.')
  if (!updated.data) return resolveShortage(input)
  return { shortage: updated.data as QcShortage, changed: true }
}
