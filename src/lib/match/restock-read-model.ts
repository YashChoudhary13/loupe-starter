import 'server-only'

import { signKeys } from '@/lib/console/images'
import type { SignedImage } from '@/lib/console/types'
import { ShopifyClient } from '@/lib/shopify/client'
import { readProductStockBySku, type ProductStock } from '@/lib/shopify/inventory'
import { supabaseServer } from '@/lib/supabase/server'

import type { Candidate } from './types'

/** The Restock section's read model (D112): confirmed restocks waiting for their stock decision. */

export interface RestockItem {
  readonly intakeFileId: string
  readonly decisionId: string
  readonly matchEventId: string
  readonly sku: string
  readonly filename: string
  readonly surface: 'upload' | 'drive'
  readonly requestedAt: string
  readonly decisionStatus: 'pending' | 'failed' | 'inventory_set' | 'draft_created' | 'completed'
  readonly lastError: string | null
  readonly thumb: SignedImage | null
  readonly candidates: readonly (Candidate & { readonly thumbUrl: string | null; readonly title: string | null })[]
  /** Live from Shopify: every product carrying the SKU, active first. Null when Shopify could not be read. */
  readonly stock: readonly ProductStock[] | null
  readonly stockError: string | null
}

export interface RestockSnapshot {
  readonly generatedAt: string
  readonly items: readonly RestockItem[]
}

interface Row {
  id: string
  intake_file_id: string
  match_event_id: string
  sku: string
  status: RestockItem['decisionStatus']
  last_error: string | null
  created_at: string
  intake_files: { filename: string; source: 'upload' | 'drive'; source_storage_key: string | null; status: string } | null
  match_events: { thumb_key: string | null; candidates: Candidate[] | null } | null
}

function uploadThumbKey(sourceStorageKey: string | null): string | null {
  if (!sourceStorageKey) return null
  const slash = sourceStorageKey.lastIndexOf('/')
  return slash > 0 ? `${sourceStorageKey.slice(0, slash)}/thumb.webp` : null
}

export async function loadRestockQueue(): Promise<RestockSnapshot> {
  const db = supabaseServer()
  const { data, error } = await db
    .from('restock_decisions')
    .select(
      'id, intake_file_id, match_event_id, sku, status, last_error, created_at, intake_files ( filename, source, source_storage_key, status ), match_events ( thumb_key, candidates )',
    )
    .in('status', ['pending', 'failed'])
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`restock_decisions: ${error.message}`)
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => r.intake_files?.status === 'restock')

  const skus = [...new Set(rows.flatMap((r) => [r.sku, ...((r.match_events?.candidates ?? []).map((c) => c.sku))]))]
  const { data: refs } = skus.length
    ? await db.from('match_references').select('sku, title, image_url').in('sku', skus).is('retired_at', null).not('image_url', 'is', null)
    : { data: [] }
  const display = new Map<string, { title: string | null; imageUrl: string }>()
  for (const r of (refs ?? []) as { sku: string; title: string | null; image_url: string }[]) {
    if (!display.has(r.sku)) display.set(r.sku, { title: r.title, imageUrl: r.image_url })
  }

  const thumbKeys = rows.map((r) => r.match_events?.thumb_key ?? uploadThumbKey(r.intake_files?.source_storage_key ?? null))
  const signed = await signKeys(thumbKeys)

  const shopify = new ShopifyClient()
  const stockBySku = new Map<string, { stock: ProductStock[] | null; error: string | null }>()
  await Promise.all(
    [...new Set(rows.map((r) => r.sku))].map(async (sku) => {
      try {
        stockBySku.set(sku, { stock: await readProductStockBySku(shopify, sku), error: null })
      } catch (cause) {
        stockBySku.set(sku, { stock: null, error: cause instanceof Error ? cause.message : String(cause) })
      }
    }),
  )

  return {
    generatedAt: new Date().toISOString(),
    items: rows.map((r, i) => ({
      intakeFileId: r.intake_file_id,
      decisionId: r.id,
      matchEventId: r.match_event_id,
      sku: r.sku,
      filename: r.intake_files?.filename ?? 'photograph',
      surface: r.intake_files?.source === 'drive' ? 'drive' : 'upload',
      requestedAt: r.created_at,
      decisionStatus: r.status,
      lastError: r.last_error,
      thumb: (thumbKeys[i] ? signed.get(thumbKeys[i]!) : null) ?? null,
      candidates: (r.match_events?.candidates ?? []).map((c) => ({
        ...c,
        thumbUrl: display.get(c.sku)?.imageUrl ?? null,
        title: display.get(c.sku)?.title ?? null,
      })),
      stock: stockBySku.get(r.sku)?.stock ?? null,
      stockError: stockBySku.get(r.sku)?.error ?? null,
    })),
  }
}
