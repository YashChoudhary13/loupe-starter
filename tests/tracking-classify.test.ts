import { describe, expect, it } from 'vitest'

import {
  classifyDraft,
  classifyIntake,
  NOT_ENHANCED_PREFIX,
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
    enhancedAt: null,
  }
}

describe('tracking age and failure classification', () => {
  it('shows a photograph waiting in Identify as in progress, then as needing attention after a day (D110)', () => {
    const fresh = { ...intake(new Date(NOW - 60_000).toISOString()), status: 'identifying' }
    expect(classifyIntake(fresh, NOW)).toMatchObject({ group: 'progress', statusLabel: 'Identifying' })
    const stale = { ...intake(new Date(NOW - STALE_UNGROUPED_MS).toISOString()), status: 'identifying' }
    expect(classifyIntake(stale, NOW)).toMatchObject({ group: 'attention', statusLabel: 'Waiting to be identified' })
  })

  it('keeps a confirmed restock under attention until its stock change is done, then completes it', () => {
    expect(classifyIntake({ ...intake(new Date(NOW - 60_000).toISOString()), status: 'restock' }, NOW))
      .toMatchObject({ group: 'attention', statusLabel: 'Restock to confirm' })
    expect(classifyIntake({ ...intake(new Date(NOW - 60_000).toISOString()), status: 'restocked' }, NOW))
      .toMatchObject({ group: 'complete', statusLabel: 'Restocked' })
  })

  it('retires healthy enhanced work from tracking — it lives in the console', () => {
    expect(classifyIntake(intake(new Date(NOW - STALE_UNGROUPED_MS + 1).toISOString()), NOW))
      .toMatchObject({ group: 'hidden', statusLabel: 'Enhanced' })
  })

  it('shows a freshly delivered photograph in progress with its tick, then lets it retire', () => {
    const fresh = {
      ...intake(new Date(NOW - 60_000).toISOString()),
      enhancedAt: new Date(NOW - 30_000).toISOString(),
    }
    expect(classifyIntake(fresh, NOW)).toMatchObject({
      group: 'progress',
      tone: 'complete',
      statusLabel: 'Enhanced ✓',
    })
    const older = {
      ...fresh,
      enhancedAt: new Date(NOW - 11 * 60_000).toISOString(),
    }
    expect(classifyIntake(older, NOW)).toMatchObject({ group: 'hidden' })
  })

  /**
   * D144: a photograph that reached the console as it is — nothing rendered it
   * inside Loupe — carries the note and is worth a look before it is listed.
   * Once grouped into a draft the note stops counting; the draft represents it.
   */
  it('flags a photograph that went to the console without a render', () => {
    const row = {
      ...intake(new Date(NOW - 60_000).toISOString()),
      enhancedAt: new Date(NOW - 60_000).toISOString(),
      lastError: `${NOT_ENHANCED_PREFIX}: send it through /enhance or upload a finished image.`,
    }
    expect(classifyIntake(row, NOW)).toMatchObject({
      group: 'attention',
      tone: 'stalled',
      statusLabel: 'Not enhanced',
      reason: row.lastError,
    })
    expect(classifyIntake({ ...row, productDraftId: 'draft-1' }, NOW).group).not.toBe('attention')
  })

  it('hides a row the D144 conversion has not reached instead of inventing a queue', () => {
    expect(classifyIntake({ ...intake(new Date(NOW - 60_000).toISOString()), status: 'discovered' }, NOW))
      .toMatchObject({ group: 'hidden' })
  })

  it('flags a draft whose background Shopify push failed', () => {
    expect(
      classifyDraft(
        {
          status: 'assembling',
          updatedAt: new Date(NOW - 1_000).toISOString(),
          error: 'Shopify returned HTTP 502.',
          publishLeaseExpiresAt: null,
          shopifyProductId: null,
        },
        NOW,
      ),
    ).toMatchObject({
      group: 'attention',
      statusLabel: 'Shopify draft failed',
      reason: 'Shopify returned HTTP 502.',
    })
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
        shopifyProductId: null,
      },
      NOW,
    )
    expect(result).toMatchObject({ group: 'attention', statusLabel: 'Publish interrupted' })
    expect(result.reason).toContain('same handle')
  })

  /**
   * Qimati's workflow is to draft everything into Shopify and publish the batch
   * on launch day, so a draft sitting untouched in Shopify for a week is the
   * intended end state. See D90.
   */
  const oldDraft = {
    status: 'assembling',
    updatedAt: new Date(NOW - 8 * 24 * 3_600_000).toISOString(),
    error: null,
    publishLeaseExpiresAt: null,
  }

  it('leaves a week-old draft alone once it has reached Shopify', () => {
    expect(
      classifyDraft({ ...oldDraft, shopifyProductId: 'gid://shopify/Product/1' }, NOW),
    ).toMatchObject({ group: 'draft', statusLabel: 'In Shopify' })
  })

  it('still flags a stale draft that never reached Shopify', () => {
    const result = classifyDraft({ ...oldDraft, shopifyProductId: null }, NOW)
    expect(result).toMatchObject({ group: 'attention', statusLabel: 'Draft stalled' })
    expect(result.reason).toContain('never been sent to Shopify')
  })

  it('does not call a fresh un-sent draft stalled', () => {
    expect(
      classifyDraft(
        { ...oldDraft, updatedAt: new Date(NOW - 1_000).toISOString(), shopifyProductId: null },
        NOW,
      ),
    ).toMatchObject({ group: 'draft', statusLabel: 'Draft' })
  })
})
