import { describe, expect, it } from 'vitest'

import {
  preserveThumbs,
  startOfKolkataDayIso,
  tilesForQueueView,
  type QueueView,
} from '@/lib/console/queue-view'
import type { QueueSnapshot, QueueTile } from '@/lib/console/types'

function tile(
  kind: QueueTile['kind'],
  id: string,
  attention: string | null = null,
): QueueTile {
  return {
    kind,
    id,
    label: id,
    thumb: null,
    imageCount: 1,
    categoryName: kind === 'draft' ? 'Necklaces' : null,
    status: kind === 'draft' ? 'assembling' : 'enhanced',
    attention,
    reservedSku: null,
  }
}

const ungrouped = tile('photo', 'ungrouped')
const stale = tile('photo', 'stale', 'Waiting 2d for an operator')
const draft = tile('draft', 'draft')
const listed = { ...tile('draft', 'listed'), status: 'published', reservedSku: 'NK143' }

const queue: QueueSnapshot = {
  tiles: [draft, ungrouped, stale],
  listedTodayTiles: [listed],
  ungroupedCount: 2,
  draftCount: 1,
  publishedToday: 1,
  attentionCount: 1,
  pipelineActivity: { uploading: 0, processing: 0 },
  signedUntil: 0,
  generatedAt: '2026-07-30T00:00:00.000Z',
}

describe('console queue views', () => {
  it.each<[QueueView, readonly string[]]>([
    // Pending means photographs not yet made into a product. A saved draft
    // belongs to Drafts and must not also read as outstanding work.
    ['pending', ['ungrouped', 'stale']],
    ['ungrouped', ['ungrouped', 'stale']],
    ['listed', ['listed']],
    ['attention', ['stale']],
    ['drafts', ['draft']],
  ])('shows only the rows represented by the %s counter', (view, ids) => {
    expect(tilesForQueueView(queue, view).map((item) => item.id)).toEqual(ids)
  })

  it('takes “today” from Jaipur, not the server timezone', () => {
    expect(startOfKolkataDayIso(new Date('2026-07-30T18:29:59.999Z'))).toBe(
      '2026-07-29T18:30:00.000Z',
    )
    expect(startOfKolkataDayIso(new Date('2026-07-30T18:30:00.000Z'))).toBe(
      '2026-07-30T18:30:00.000Z',
    )
  })
})

describe('preserving presigned thumbnails across a refresh', () => {
  const NOW = 1_800_000_000_000
  const fresh = { url: 'https://r2/old-signed', expiresAt: NOW + 10 * 60_000 }
  const expiring = { url: 'https://r2/nearly-dead', expiresAt: NOW + 20_000 }
  const rotated = { url: 'https://r2/new-signed', expiresAt: NOW + 15 * 60_000 }

  const withThumb = (id: string, thumb: QueueTile['thumb']): QueueTile => ({
    ...tile('photo', id),
    thumb,
  })
  const snapshot = (tiles: readonly QueueTile[]): QueueSnapshot => ({ ...queue, tiles })

  it('reuses a still-valid URL so the browser does not re-download the grid', () => {
    const result = preserveThumbs(
      snapshot([withThumb('a', fresh)]),
      snapshot([withThumb('a', rotated)]),
      NOW,
    )
    expect(result.tiles[0]?.thumb).toEqual(fresh)
  })

  it('takes the new URL when the old one is about to expire', () => {
    const result = preserveThumbs(
      snapshot([withThumb('a', expiring)]),
      snapshot([withThumb('a', rotated)]),
      NOW,
    )
    expect(result.tiles[0]?.thumb).toEqual(rotated)
  })

  it('never resurrects a tile, a count or an attention flag from the old snapshot', () => {
    const previous = { ...snapshot([withThumb('a', fresh)]), ungroupedCount: 9 }
    const next: QueueSnapshot = {
      ...snapshot([{ ...withThumb('a', rotated), attention: 'Possible duplicate' }]),
      ungroupedCount: 1,
      pipelineActivity: { uploading: 2, processing: 1 },
    }

    const result = preserveThumbs(previous, next, NOW)
    // Only the image URL is inherited; every other field is the new truth.
    expect(result.tiles[0]?.thumb).toEqual(fresh)
    expect(result.tiles[0]?.attention).toBe('Possible duplicate')
    expect(result.ungroupedCount).toBe(1)
    expect(result.pipelineActivity).toEqual({ uploading: 2, processing: 1 })
  })

  it('drops the URL of a tile that no longer exists', () => {
    const result = preserveThumbs(
      snapshot([withThumb('gone', fresh)]),
      snapshot([withThumb('new', rotated)]),
      NOW,
    )
    expect(result.tiles.map((item) => item.id)).toEqual(['new'])
    expect(result.tiles[0]?.thumb).toEqual(rotated)
  })
})
