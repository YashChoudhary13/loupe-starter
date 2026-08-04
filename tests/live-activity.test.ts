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
  it('collapses a complete fast pipeline cycle into one ready notice', () => {
    const photoId = '00000000-0000-0000-0000-000000000001'
    expect(
      noticesForLiveEvents([
        event(1, 'intake.discovered', photoId),
        event(2, 'intake.claimed', photoId),
        event(3, 'description.stored', photoId),
        event(4, 'image.generated', photoId),
        event(5, 'intake.enhanced', photoId),
      ]),
    ).toEqual([
      {
        key: 'new-ready:5',
        text: '1 new photo enhanced and ready',
        tone: 'ready',
        href: '/console',
      },
    ])
  })

  it('reports queue arrival, active processing, completion and failures', () => {
    expect(noticesForLiveEvents([event(10, 'intake.discovered')])[0]?.text).toBe(
      '1 new photo added to the queue',
    )
    expect(noticesForLiveEvents([event(11, 'intake.claimed')])[0]?.text).toBe(
      'Enhancing 1 photo',
    )
    expect(noticesForLiveEvents([event(12, 'intake.enhanced')])[0]?.text).toBe(
      '1 photo enhanced and ready',
    )
    expect(noticesForLiveEvents([event(13, 'intake.failed')])[0]?.text).toBe(
      '1 process needs attention',
    )
  })

  it('refreshes heavy screens only for transitions that change their visible state', () => {
    expect(shouldRefreshConsole([event(20, 'description.stored')])).toBe(false)
    expect(shouldRefreshConsole([event(21, 'intake.enhanced')])).toBe(true)
    expect(shouldRefreshTracking([event(22, 'image.generated')])).toBe(false)
    expect(shouldRefreshTracking([event(23, 'intake.claimed')])).toBe(true)
    expect(shouldRefreshTracking([event(24, 'intake.failed')])).toBe(true)
  })
})
