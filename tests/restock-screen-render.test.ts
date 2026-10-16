import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/app/(shell)/restock/actions', () => ({
  decideRestockCandidateAction: vi.fn(), deleteRestockAction: vi.fn(), newSkuFromRestockAction: vi.fn(), refreshRestockAction: vi.fn(),
  refreshRestockCandidatesAction: vi.fn(), reopenIdentificationAction: vi.fn(), restockExistingAction: vi.fn(), saveReferenceOnlyAction: vi.fn(),
}))
import { RestockScreen } from '@/components/restock/RestockScreen'
import type { RestockCandidateItem } from '@/lib/agent-intake/restock'
import type { RestockItem, RestockSnapshot } from '@/lib/match/restock-read-model'

const candidate: RestockCandidateItem = {
  photoId: 'p1', filename: '1000169922.jpg', batch: '2026-10-16 17.49', postedAt: '2026-10-16T12:19:17Z', kind: 'old', note: 'same clasp', thumb: null, photo: null,
  candidates: [{ sku: 'CB554', handle: 'chain-bracelet-554', title: 'Chain Bracelet 554', imageUrl: null, status: 'ACTIVE', available: 0, pricePaise: 15000, createdAt: null, suggest: null }],
}
const item: RestockItem = {
  intakeFileId: 'f1', decisionId: 'd1', matchEventId: 'm1', sku: 'NK784', filename: 'IMG20260822155833.jpg', surface: 'upload', requestedAt: '2026-10-13T09:24:07Z',
  decisionStatus: 'pending', lastError: null, thumb: null, candidates: [], stock: null, stockError: null,
}
const snapshot = (items: RestockItem[]): RestockSnapshot => ({ generatedAt: '2026-10-17T00:00:00Z', items })
const render = (candidates: RestockCandidateItem[], items: RestockItem[]) =>
  renderToString(createElement(RestockScreen, { initialSnapshot: snapshot(items), initialCandidates: candidates })).replace(/<!-- -->/g, '')

describe('Restock screen (D154)', () => {
  it('every card has Delete beside its choices, and Clear all counts both kinds', () => {
    const html = render([candidate], [item])
    expect(html.match(/>Delete<\/button>/g)).toHaveLength(2)
    expect(html).toContain('Clear all · 2')
    expect(html).toContain('Use old image of CB554'); expect(html).toContain('Wrong restock'); expect(html).toContain('Just save as reference')
    expect(html).not.toContain('Delete all 2')
  })
  it('an empty section has nothing to clear', () => {
    const html = render([], [])
    expect(html).toContain('Nothing to restock.')
    expect(html).not.toContain('Clear all')
  })
})
