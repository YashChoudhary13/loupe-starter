import 'server-only'

import { signKeys } from '@/lib/console/images'
import type { SignedImage } from '@/lib/console/types'
import { supabaseServer } from '@/lib/supabase/server'

import type { Candidate } from './types'

/**
 * What the Identify screen shows (D110). Read-only projection; every mutation
 * goes through decide_identification / confirm_identification.
 */

export interface IdentifyCandidate extends Candidate {
  readonly title: string | null
  readonly thumbUrl: string | null
}

export interface IdentifyItem {
  readonly matchEventId: string
  readonly surface: 'upload' | 'drive' | 'identify'
  readonly intakeFileId: string | null
  readonly filename: string
  readonly status: 'queued' | 'matched'
  readonly requestedAt: string
  readonly matchedAt: string | null
  readonly thumb: SignedImage | null
  readonly candidates: readonly IdentifyCandidate[] | null
}

export interface IdentifySnapshot {
  readonly generatedAt: string
  /** Last heartbeat of any vision worker; null when none has ever reported. */
  readonly workerSeenAt: string | null
  readonly items: readonly IdentifyItem[]
  readonly truncated: boolean
}

const ITEM_LIMIT = 200

interface EventRow {
  id: string
  surface: 'upload' | 'drive' | 'identify'
  intake_file_id: string | null
  query_storage_key: string
  thumb_key: string | null
  status: 'queued' | 'matched'
  created_at: string
  matched_at: string | null
  candidates: Candidate[] | null
  intake_files: { filename: string; source_storage_key: string | null } | null
}

interface ReferenceRow {
  sku: string
  title: string | null
  image_url: string | null
  source: string
}

/** The raw upload's own thumbnail sits beside its source object (manual-upload/server.ts). */
function uploadThumbKey(sourceStorageKey: string | null): string | null {
  if (!sourceStorageKey) return null
  const slash = sourceStorageKey.lastIndexOf('/')
  return slash > 0 ? `${sourceStorageKey.slice(0, slash)}/thumb.webp` : null
}

export async function loadIdentifyQueue(): Promise<IdentifySnapshot> {
  const db = supabaseServer()
  const [eventsResult, workerResult] = await Promise.all([
    db
      .from('match_events')
      .select(
        'id, surface, intake_file_id, query_storage_key, thumb_key, status, created_at, matched_at, candidates, intake_files ( filename, source_storage_key )',
      )
      .in('status', ['queued', 'matched'])
      .order('created_at', { ascending: false })
      .limit(ITEM_LIMIT + 1),
    db.from('match_workers').select('last_seen_at').order('last_seen_at', { ascending: false }).limit(1),
  ])
  if (eventsResult.error) throw new Error(`match_events: ${eventsResult.error.message}`)
  if (workerResult.error) throw new Error(`match_workers: ${workerResult.error.message}`)

  const rows = (eventsResult.data ?? []) as unknown as EventRow[]
  const truncated = rows.length > ITEM_LIMIT
  const events = truncated ? rows.slice(0, ITEM_LIMIT) : rows

  const skus = [...new Set(events.flatMap((e) => (e.candidates ?? []).map((c) => c.sku)))]
  const display = await candidateDisplay(skus)

  const thumbKeys = events.map((e) => e.thumb_key ?? uploadThumbKey(e.intake_files?.source_storage_key ?? null))
  const signed = await signKeys([...thumbKeys, ...display.thumbKeys])

  const items: IdentifyItem[] = events.map((e, i) => ({
    matchEventId: e.id,
    surface: e.surface,
    intakeFileId: e.intake_file_id,
    filename: e.intake_files?.filename ?? e.query_storage_key.split('/').pop() ?? 'photograph',
    status: e.status,
    requestedAt: e.created_at,
    matchedAt: e.matched_at,
    thumb: (thumbKeys[i] ? signed.get(thumbKeys[i]!) : null) ?? null,
    candidates: e.candidates
      ? e.candidates.map((c) => {
          const d = display.bySku.get(c.sku)
          const thumbUrl = d?.imageUrl ?? (d?.thumbKey ? (signed.get(d.thumbKey)?.url ?? null) : null)
          return { ...c, title: d?.title ?? null, thumbUrl }
        })
      : null,
  }))

  return {
    generatedAt: new Date().toISOString(),
    workerSeenAt: (workerResult.data?.[0] as { last_seen_at: string } | undefined)?.last_seen_at ?? null,
    items,
    truncated,
  }
}

/**
 * How a candidate SKU is shown: the catalogue's own image and title when the
 * SKU is in the imported catalogue, else the thumbnail of the product Loupe
 * published (if retention has not purged it yet), else the SKU alone.
 */
async function candidateDisplay(skus: readonly string[]): Promise<{
  bySku: Map<string, { title: string | null; imageUrl: string | null; thumbKey: string | null }>
  thumbKeys: string[]
}> {
  const bySku = new Map<string, { title: string | null; imageUrl: string | null; thumbKey: string | null }>()
  if (skus.length === 0) return { bySku, thumbKeys: [] }
  const db = supabaseServer()

  const { data: refs, error: refError } = await db
    .from('match_references')
    .select('sku, title, image_url, source')
    .in('sku', skus)
    .is('retired_at', null)
  if (refError) throw new Error(`match_references: ${refError.message}`)
  for (const r of (refs ?? []) as ReferenceRow[]) {
    const current = bySku.get(r.sku)
    if (current?.imageUrl) continue
    bySku.set(r.sku, { title: r.title ?? current?.title ?? null, imageUrl: r.image_url ?? null, thumbKey: null })
  }

  const missing = skus.filter((s) => !bySku.get(s)?.imageUrl)
  if (missing.length === 0) return { bySku, thumbKeys: [] }

  const { data: drafts, error: draftError } = await db
    .from('product_drafts')
    .select('reserved_sku, product_draft_images ( position, image_versions ( thumb_key, purged_at ) )')
    .in('reserved_sku', missing)
  if (draftError) throw new Error(`product_drafts: ${draftError.message}`)
  const thumbKeys: string[] = []
  for (const d of (drafts ?? []) as unknown as {
    reserved_sku: string
    product_draft_images: { position: number; image_versions: { thumb_key: string | null; purged_at: string | null } | null }[]
  }[]) {
    const first = [...(d.product_draft_images ?? [])]
      .sort((a, b) => a.position - b.position)
      .find((img) => img.image_versions?.thumb_key && !img.image_versions.purged_at)
    const thumbKey = first?.image_versions?.thumb_key ?? null
    if (!thumbKey) continue
    thumbKeys.push(thumbKey)
    const current = bySku.get(d.reserved_sku)
    bySku.set(d.reserved_sku, { title: current?.title ?? null, imageUrl: null, thumbKey })
  }
  return { bySku, thumbKeys }
}
