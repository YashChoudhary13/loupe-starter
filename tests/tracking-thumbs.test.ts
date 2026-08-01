import { describe, expect, it } from 'vitest'

import {
  draftCoverKeys,
  preferredThumbKey,
  type DraftCoverCandidate,
  type ThumbCandidate,
} from '@/lib/tracking/thumbs'

function version(overrides: Partial<ThumbCandidate> = {}): ThumbCandidate {
  return {
    versionNo: 1,
    isSelected: false,
    thumbKey: 'versions/a/v1_thumb.webp',
    purgedAt: null,
    ...overrides,
  }
}

describe('which thumbnail represents a photograph', () => {
  it('prefers the selected version over a newer unselected one', () => {
    expect(
      preferredThumbKey([
        version({ versionNo: 3, thumbKey: 'v3' }),
        version({ versionNo: 2, thumbKey: 'v2', isSelected: true }),
      ]),
    ).toBe('v2')
  })

  it('falls back to the newest when nothing is selected', () => {
    expect(
      preferredThumbKey([
        version({ versionNo: 1, thumbKey: 'v1' }),
        version({ versionNo: 4, thumbKey: 'v4' }),
      ]),
    ).toBe('v4')
  })

  it('never returns a purged version, even when it is the selected one', () => {
    // Retention deletes the R2 object seven days after publish and keeps the row
    // for the audit trail (D5). The key still reads and still presigns — and
    // 404s in the browser. This breaks a week after the work, on published
    // products only, which is why it is asserted rather than assumed.
    expect(
      preferredThumbKey([
        version({ versionNo: 2, thumbKey: 'v2', isSelected: true, purgedAt: '2026-07-01T00:00:00Z' }),
      ]),
    ).toBeNull()
  })

  it('skips a version that has no thumbnail rather than reporting none at all', () => {
    expect(
      preferredThumbKey([
        version({ versionNo: 2, thumbKey: null, isSelected: true }),
        version({ versionNo: 1, thumbKey: 'v1' }),
      ]),
    ).toBe('v1')
  })

  it('has no thumbnail for a photograph with no versions', () => {
    expect(preferredThumbKey([])).toBeNull()
  })
})

function image(overrides: Partial<DraftCoverCandidate> = {}): DraftCoverCandidate {
  return {
    draftId: 'draft-1',
    position: 0,
    thumbKey: 'cover',
    purgedAt: null,
    ...overrides,
  }
}

describe('which photograph covers a product draft', () => {
  it('takes the lowest position, whatever order the rows arrive in', () => {
    expect(
      draftCoverKeys([
        image({ position: 2, thumbKey: 'third' }),
        image({ position: 0, thumbKey: 'first' }),
        image({ position: 1, thumbKey: 'second' }),
      ]).get('draft-1'),
    ).toBe('first')
  })

  it('keeps drafts separate', () => {
    const covers = draftCoverKeys([
      image({ draftId: 'a', thumbKey: 'a-cover' }),
      image({ draftId: 'b', thumbKey: 'b-cover' }),
    ])
    expect([...covers]).toEqual([
      ['a', 'a-cover'],
      ['b', 'b-cover'],
    ])
  })

  it('shows no cover rather than promoting a different photograph when the cover is purged', () => {
    // Silently falling through to image 2 would make two different products in
    // the list look like the same one.
    const covers = draftCoverKeys([
      image({ position: 0, thumbKey: 'cover', purgedAt: '2026-07-01T00:00:00Z' }),
      image({ position: 1, thumbKey: 'second' }),
    ])
    expect(covers.has('draft-1')).toBe(false)
  })

  it('has no cover for a draft with no images yet', () => {
    expect(draftCoverKeys([]).size).toBe(0)
  })
})
