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
  /** Full-size image for the lightbox; null when only a thumbnail survives. */
  readonly fullUrl: string | null
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
  /** The photograph itself (R2 original or the identify upload); null for a Drive photo not yet copied. */
  readonly full: SignedImage | null
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
  intake_files: {
    filename: string
    source_storage_key: string | null
    image_versions: { kind: string; storage_key: string; purged_at: string | null }[] | null
  } | null
}

interface ReferenceRow {
  sku: string
  title: string | null
  image_url: string | null
  source: string
}

/** Where the full photograph lives: its own R2 key, or for a Drive photo the original Loupe copied at enhancement. */
function fullQueryKey(e: EventRow): string | null {
  if (!e.query_storage_key.startsWith('drive:')) return e.query_storage_key
  return e.intake_files?.image_versions?.find((v) => v.kind === 'original' && !v.purged_at)?.storage_key ?? null
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
        'id, surface, intake_file_id, query_storage_key, thumb_key, status, created_at, matched_at, candidates, intake_files ( filename, source_storage_key, image_versions ( kind, storage_key, purged_at ) )',
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
  const fullKeys = events.map(fullQueryKey)
  const signed = await signKeys([...thumbKeys, ...fullKeys, ...display.keys])

  const items: IdentifyItem[] = events.map((e, i) => ({
    matchEventId: e.id,
    surface: e.surface,
    intakeFileId: e.intake_file_id,
    filename: e.intake_files?.filename ?? e.query_storage_key.split('/').pop() ?? 'photograph',
    status: e.status,
    requestedAt: e.created_at,
    matchedAt: e.matched_at,
    thumb: (thumbKeys[i] ? signed.get(thumbKeys[i]!) : null) ?? null,
    full: (fullKeys[i] ? signed.get(fullKeys[i]!) : null) ?? null,
    candidates: e.candidates
      ? e.candidates.map((c) => {
          const d = display.bySku.get(c.sku)
          const thumbUrl = d?.imageUrl ?? (d?.thumbKey ? (signed.get(d.thumbKey)?.url ?? null) : null)
          const fullUrl = d?.imageUrl ?? (d?.fullKey ? (signed.get(d.fullKey)?.url ?? null) : null)
          return { ...c, title: d?.title ?? null, thumbUrl, fullUrl }
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
  bySku: Map<string, Display>
  /** R2 keys to presign: thumbnails and full versions of the Loupe-published fallbacks. */
  keys: string[]
}> {
  const bySku = new Map<string, Display>()
  if (skus.length === 0) return { bySku, keys: [] }
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
    bySku.set(r.sku, { title: r.title ?? current?.title ?? null, imageUrl: r.image_url ?? null, thumbKey: null, fullKey: null })
  }

  const missing = skus.filter((s) => !bySku.get(s)?.imageUrl)
  if (missing.length === 0) return { bySku, keys: [] }

  const { data: drafts, error: draftError } = await db
    .from('product_drafts')
    .select('reserved_sku, product_draft_images ( position, image_versions ( thumb_key, storage_key, purged_at ) )')
    .in('reserved_sku', missing)
  if (draftError) throw new Error(`product_drafts: ${draftError.message}`)
  const keys: string[] = []
  for (const d of (drafts ?? []) as unknown as {
    reserved_sku: string
    product_draft_images: { position: number; image_versions: { thumb_key: string | null; storage_key: string; purged_at: string | null } | null }[]
  }[]) {
    const first = [...(d.product_draft_images ?? [])]
      .sort((a, b) => a.position - b.position)
      .find((img) => img.image_versions?.thumb_key && !img.image_versions.purged_at)
    const thumbKey = first?.image_versions?.thumb_key ?? null
    if (!thumbKey) continue
    const fullKey = first?.image_versions?.storage_key ?? null
    keys.push(thumbKey)
    if (fullKey) keys.push(fullKey)
    const current = bySku.get(d.reserved_sku)
    bySku.set(d.reserved_sku, { title: current?.title ?? null, imageUrl: null, thumbKey, fullKey })
  }
  return { bySku, keys }
}

interface Display {
  title: string | null
  /** Catalogue CDN image — already full size, used for thumbnail and lightbox alike. */
  imageUrl: string | null
  thumbKey: string | null
  fullKey: string | null
}
