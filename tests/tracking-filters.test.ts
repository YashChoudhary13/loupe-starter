import { describe, expect, it } from 'vitest'

import { filterTrackingRows, type TrackingFilters } from '@/lib/tracking/filters'
import type { TrackingRow } from '@/lib/tracking/types'

const NOW = Date.parse('2026-07-31T12:00:00.000Z')

function row(overrides: Partial<TrackingRow> = {}): TrackingRow {
  return {
    rowId: 'intake:1',
    kind: 'intake',
    entityId: '1',
    label: 'IMG_1.jpg',
    statusLabel: 'Failed',
    tone: 'failed',
    group: 'attention',
    occurredAt: '2026-07-31T10:00:00.000Z',
    reason: 'Rate limited',
    errorCode: 'rate_limited',
    errorClass: 'retryable',
    costUsd: null,
    rawDetail: null,
    thumb: null,
    events: [],
    canRetry: true,
    canSkip: true,
    consoleHref: null,
    driveHref: null,
    duplicate: null,
    ...overrides,
  }
}

const defaults: TrackingFilters = {
  view: 'all',
  status: 'any',
  error: '',
  age: 'any',
  search: '',
}

describe('tracking filters', () => {
  const rows = [
    row(),
    row({
      rowId: 'draft:2',
      label: 'NK002',
      group: 'progress',
      tone: 'running',
      errorCode: null,
      reason: 'Publishing',
      occurredAt: '2026-07-31T11:50:00.000Z',
    }),
  ]

  it('separates needs-attention and progress views', () => {
    expect(filterTrackingRows(rows, { ...defaults, view: 'attention' }, NOW)).toHaveLength(1)
    expect(filterTrackingRows(rows, { ...defaults, view: 'progress' }, NOW)[0]?.label).toBe('NK002')
  })

  it('filters by status, exact error, age and filename text', () => {
    expect(
      filterTrackingRows(
        rows,
        {
          ...defaults,
          status: 'failed',
          error: 'rate_limited',
          age: '1h',
          search: 'img_1',
        },
        NOW,
      ),
    ).toEqual([rows[0]])
  })

  it('does not include a ten-minute row in over-one-hour results', () => {
    expect(filterTrackingRows(rows, { ...defaults, age: '1h' }, NOW)).toEqual([rows[0]])
  })
})
