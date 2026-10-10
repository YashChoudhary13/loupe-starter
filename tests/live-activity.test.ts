import { describe, expect, it } from 'vitest'

import {
  noticesForLiveEvents,
  shouldRefreshConsole,
  shouldRefreshTracking,
  type LiveActivityEvent,
} from '@/lib/live/types'

function event(
  id: number,
  name: string,
  entityId: string | null = `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`,
): LiveActivityEvent {
  return {
    id,
    entityType: 'intake_file',
    entityId,
    event: name,
    occurredAt: '2026-08-04T12:00:00.000Z',
  }
}

describe('global live activity', () => {
  it('collapses several arrivals of one photograph into one ready notice', () => {
    const photoId = '00000000-0000-0000-0000-000000000001'
    expect(
      noticesForLiveEvents([
        event(1, 'intake.manual_uploaded', photoId),
        event(2, 'intake.enhanced', photoId),
      ]),
    ).toEqual([
      { key: 'ready:2', text: '1 photo ready in the console', tone: 'ready', href: '/console' },
    ])
  })

  it('reports deliveries, D144 as-is arrivals, failures and Shopify push failures', () => {
    expect(noticesForLiveEvents([event(12, 'intake.enhanced')])[0]?.text).toBe('1 photo ready in the console')
    expect(noticesForLiveEvents([event(13, 'intake.original_selected')])[0]?.text).toBe('1 photo ready in the console')
    expect(noticesForLiveEvents([event(14, 'intake.failed')])[0]?.text).toBe('1 process needs attention')
    expect(noticesForLiveEvents([event(15, 'draft.shopify_push_failed')])[0]?.text).toBe(
      '1 draft could not reach Shopify — open to retry',
    )
    // A later successful sync of the same draft withdraws the warning.
    const draftId = 'draft-1'
    expect(
      noticesForLiveEvents([event(16, 'draft.shopify_push_failed', draftId), event(17, 'draft.shopify_synced', draftId)]),
    ).toEqual([])
  })

  it('refreshes heavy screens only for transitions that change their visible state', () => {
    expect(shouldRefreshConsole([event(20, 'match.decided')])).toBe(false)
    expect(shouldRefreshConsole([event(21, 'intake.enhanced')])).toBe(true)
    expect(shouldRefreshConsole([event(22, 'intake.original_selected')])).toBe(true)
    expect(shouldRefreshTracking([event(23, 'image.generated')])).toBe(false)
    expect(shouldRefreshTracking([event(24, 'intake.original_selected')])).toBe(true)
    expect(shouldRefreshTracking([event(25, 'intake.failed')])).toBe(true)
  })
})
