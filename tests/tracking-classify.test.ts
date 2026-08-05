import { describe, expect, it } from 'vitest'

import {
  classifyDraft,
  classifyIntake,
  STALE_UNGROUPED_MS,
} from '@/lib/tracking/classify'

const NOW = Date.parse('2026-07-31T12:00:00.000Z')

function intake(discoveredAt: string) {
  return {
    status: 'enhanced',
    discoveredAt,
    productDraftId: null,
    lastError: null,
    errorClass: null,
    leaseExpiresAt: null,
    providerPausedAt: null,
    providerPauseCode: null,
    providerPauseMessage: null,
  }
}

describe('tracking age and failure classification', () => {
  it('does not call recent enhanced work an error', () => {
    expect(classifyIntake(intake(new Date(NOW - STALE_UNGROUPED_MS + 1).toISOString()), NOW))
      .toMatchObject({ group: 'progress', statusLabel: 'Enhanced' })
  })

  it('marks the exact 24-hour ungrouped boundary stalled', () => {
    expect(classifyIntake(intake(new Date(NOW - STALE_UNGROUPED_MS).toISOString()), NOW))
      .toMatchObject({ group: 'attention', statusLabel: 'Stalled' })
  })

  it('makes a failure immediate, regardless of age', () => {
    expect(
      classifyIntake(
        {
          ...intake(new Date(NOW - 1_000).toISOString()),
          status: 'failed',
          lastError: 'The provider refused this source.',
          errorClass: 'permanent',
        },
        NOW,
      ),
    ).toMatchObject({
      group: 'attention',
      tone: 'failed',
      reason: 'The provider refused this source.',
    })
  })

  it('shows provider credit exhaustion immediately with an actionable explanation', () => {
    expect(
      classifyIntake(
        {
          ...intake(new Date(NOW - 1_000).toISOString()),
          status: 'discovered',
          providerPausedAt: new Date(NOW - 500).toISOString(),
          providerPauseCode: 'image_provider_quota_exhausted',
          providerPauseMessage:
            'Image generation is paused because the provider account needs more credits. Add credits, then choose Resume enhancement.',
        },
        NOW,
      ),
    ).toMatchObject({
      group: 'attention',
      tone: 'failed',
      statusLabel: 'Credits required',
      reason: expect.stringContaining('Resume enhancement'),
    })
  })

  it('surfaces a duplicate warning without calling it a block', () => {
    const result = classifyIntake(intake(new Date(NOW - 1_000).toISOString()), NOW, 'IMG_1.jpg')
    expect(result).toMatchObject({ group: 'attention', statusLabel: 'Possible duplicate' })
    expect(result.reason).toContain('does not block')
  })

  it('surfaces an expired publish lease and tells the operator retry is safe', () => {
    const result = classifyDraft(
      {
        status: 'publishing',
        updatedAt: new Date(NOW - 1_000).toISOString(),
        error: null,
        publishLeaseExpiresAt: new Date(NOW - 1).toISOString(),
      },
      NOW,
    )
    expect(result).toMatchObject({ group: 'attention', statusLabel: 'Publish interrupted' })
    expect(result.reason).toContain('same handle')
  })
})
