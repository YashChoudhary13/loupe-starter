import type { QueueSnapshot, QueueTile } from './types'

export type QueueView = 'pending' | 'ungrouped' | 'listed' | 'attention' | 'drafts'

export const QUEUE_VIEW_LABELS: Readonly<Record<QueueView, string>> = {
  pending: 'Pending',
  ungrouped: 'Ungrouped',
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
      return queue.tiles
  }
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
