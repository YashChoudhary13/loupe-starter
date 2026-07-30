import { describe, expect, it } from 'vitest'

import {
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
  signedUntil: 0,
  generatedAt: '2026-07-30T00:00:00.000Z',
}

describe('console queue views', () => {
  it.each<[QueueView, readonly string[]]>([
    ['pending', ['draft', 'ungrouped', 'stale']],
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
