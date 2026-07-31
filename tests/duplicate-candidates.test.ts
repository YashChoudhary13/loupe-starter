import { describe, expect, it } from 'vitest'

import {
  findDuplicateCandidates,
  pairKey,
  type HashPhoto,
} from '@/lib/duplicates/candidates'

function photo(overrides: Partial<HashPhoto> & Pick<HashPhoto, 'id' | 'phash'>): HashPhoto {
  return {
    filename: `${overrides.id}.jpg`,
    status: 'enhanced',
    discoveredAt: '2026-07-31T00:00:00.000Z',
    productDraftId: null,
    ...overrides,
  }
}

describe('duplicate warning candidates', () => {
  it('uses one canonical key regardless of pair order', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'))
  })

  it('finds a close historical match and excludes self', () => {
    const current = photo({ id: 'new', phash: '0000000000000003' })
    const old = photo({
      id: 'old',
      phash: '0000000000000000',
      status: 'published',
      productDraftId: 'draft',
    })

    expect(findDuplicateCandidates([current], [current, old], [])).toEqual([
      expect.objectContaining({
        intakeFileId: 'new',
        matchIntakeFileId: 'old',
        distance: 2,
      }),
    ])
  })

  it('keeps only the strongest match for one review target', () => {
    const current = photo({ id: 'new', phash: '0000000000000000' })
    const close = photo({ id: 'close', phash: '0000000000000001' })
    const weaker = photo({ id: 'weaker', phash: '000000000000000f' })
    const [candidate] = findDuplicateCandidates([current], [current, weaker, close], [])
    expect(candidate?.matchIntakeFileId).toBe('close')
    expect(candidate?.distance).toBe(1)
  })

  it('does not return a reviewed, distant, skipped or duplicate pair', () => {
    const current = photo({ id: 'new', phash: '0000000000000000' })
    const reviewed = photo({ id: 'reviewed', phash: '0000000000000001' })
    const distant = photo({ id: 'distant', phash: 'ffffffffffffffff' })
    const skipped = photo({ id: 'skipped', phash: '0000000000000000', status: 'skipped' })
    const duplicate = photo({
      id: 'duplicate',
      phash: '0000000000000000',
      status: 'duplicate',
    })

    expect(
      findDuplicateCandidates(
        [current],
        [current, reviewed, distant, skipped, duplicate],
        [{ leftIntakeFileId: 'reviewed', rightIntakeFileId: 'new' }],
      ),
    ).toEqual([])
  })

  it('chooses the later photograph when both are reviewable', () => {
    const early = photo({
      id: 'early',
      phash: '0000000000000000',
      discoveredAt: '2026-07-30T00:00:00.000Z',
    })
    const late = photo({
      id: 'late',
      phash: '0000000000000001',
      discoveredAt: '2026-07-31T00:00:00.000Z',
    })
    expect(findDuplicateCandidates([early, late], [early, late], [])[0]).toEqual(
      expect.objectContaining({ intakeFileId: 'late', matchIntakeFileId: 'early' }),
    )
  })
})
