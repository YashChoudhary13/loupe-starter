import type { QueueSnapshot, QueueTile } from './types'

export type QueueView = 'pending' | 'ungrouped' | 'listed' | 'attention' | 'drafts'

export const QUEUE_VIEW_LABELS: Readonly<Record<QueueView, string>> = {
  pending: 'Pending',
  ungrouped: 'Pending',
  listed: 'Listed today',
  attention: 'Needs attention',
  drafts: 'Drafts',
}

export function tilesForQueueView(
  queue: QueueSnapshot,
  view: QueueView,
): readonly QueueTile[] {
  switch (view) {
    case 'ungrouped':
      return queue.tiles.filter((tile) => tile.kind === 'photo')
    case 'listed':
      return queue.listedTodayTiles
    case 'attention':
      return queue.tiles.filter((tile) => tile.attention !== null)
    case 'drafts':
      return queue.tiles.filter((tile) => tile.kind === 'draft')
    default:
      // "Pending" means photographs that arrived enhanced and have not been
      // made into a product yet. Once one is saved as a draft it belongs to
      // Drafts and must leave Pending — showing it in both made a drafted
      // product look like outstanding work.
      return queue.tiles.filter((tile) => tile.kind === 'photo')
  }
}

/**
 * How long an assembling draft may hold no Shopify product before the tile says
 * so. A normal "Save draft" reserves and pushes within seconds (the push runs
 * after the response, D60), so anything still empty after this never got saved —
 * the click grouped the photograph and then died before `save_product_draft`.
 */
export const UNPUSHED_DRAFT_MINUTES = 2

/**
 * True when a draft exists in Loupe but has never reached Shopify.
 *
 * Age, not status (hard rule 5): a draft saved one second ago legitimately has
 * no `shopify_product_id` yet, because the push runs after the response. The
 * same draft still empty minutes later never got saved at all — and its tile
 * renders `reservedSku ?? categoryName`, which makes it look exactly like a
 * finished one while nothing exists in Shopify.
 */
export function isUnpushedDraft(
  draft: { status: string; shopify_product_id: string | null; updated_at: string },
  now: number = Date.now(),
): boolean {
  if (draft.status !== 'assembling' || draft.shopify_product_id !== null) return false
  return (now - new Date(draft.updated_at).getTime()) / 60_000 >= UNPUSHED_DRAFT_MINUTES
}

/**
 * Jaipur has one stable UTC offset and no daylight-saving transition. Shifting
 * into IST before taking UTC midnight gives the exact start of the operator's
 * calendar day regardless of the Vercel runtime's own timezone.
 */
export function startOfKolkataDayIso(now: Date): string {
  const kolkataOffsetMs = 5.5 * 60 * 60 * 1000
  const inKolkata = new Date(now.getTime() + kolkataOffsetMs)
  inKolkata.setUTCHours(0, 0, 0, 0)
  return new Date(inKolkata.getTime() - kolkataOffsetMs).toISOString()
}

/**
 * A queue re-read that lands while a delete is still running must not bring its
 * tiles back: the server has not reached them yet, so a fresh snapshot still
 * lists them. Tiles are compared by identity when nothing is being deleted.
 */
export function withoutDeleting(queue: QueueSnapshot, deletingIds: ReadonlySet<string>): QueueSnapshot {
  if (deletingIds.size === 0) return queue
  const tiles = queue.tiles.filter((tile) => !(tile.kind === 'photo' && deletingIds.has(tile.id)))
  return { ...queue, tiles, ungroupedCount: Math.max(0, queue.ungroupedCount - (queue.tiles.length - tiles.length)) }
}
