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
 * Carry still-valid presigned thumbnail URLs from one snapshot to the next.
 *
 * A presigned URL is different on every call, so replacing a snapshot wholesale
 * changes every `img src` on the page even when nothing about the photograph
 * changed — and the browser re-downloads the entire grid. At a five-second poll
 * that is a download storm, and it is what made the console feel laggy and
 * swallow clicks.
 *
 * A URL is reused only while it has at least a minute of life left, so a tile
 * never inherits a URL that is about to expire mid-view. Everything else in the
 * snapshot (counts, attention, status, which tiles exist) always comes from the
 * NEW data — this preserves image identity, never stale state.
 */
export function preserveThumbs(
  previous: QueueSnapshot,
  next: QueueSnapshot,
  now: number = Date.now(),
): QueueSnapshot {
  const stillValid = new Map<string, QueueTile['thumb']>()
  for (const tile of [...previous.tiles, ...previous.listedTodayTiles]) {
    if (tile.thumb && tile.thumb.expiresAt > now + 60_000) stillValid.set(tile.id, tile.thumb)
  }
  if (stillValid.size === 0) return next

  const keep = (tiles: readonly QueueTile[]): QueueTile[] =>
    tiles.map((tile) => {
      const previousThumb = stillValid.get(tile.id)
      return previousThumb && tile.thumb ? { ...tile, thumb: previousThumb } : tile
    })

  return {
    ...next,
    tiles: keep(next.tiles),
    listedTodayTiles: keep(next.listedTodayTiles),
  }
}
