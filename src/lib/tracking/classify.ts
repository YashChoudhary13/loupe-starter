import type { TrackingGroup, TrackingTone } from './types'

export const STALE_UNGROUPED_MS = 24 * 60 * 60 * 1000
export const STALE_PIPELINE_MS = 60 * 60 * 1000
export const STALE_DRAFT_MS = 24 * 60 * 60 * 1000

export interface IntakeForTracking {
  readonly status: string
  readonly discoveredAt: string
  readonly productDraftId: string | null
  readonly lastError: string | null
  readonly errorClass: string | null
  readonly leaseExpiresAt: string | null
  readonly providerPausedAt: string | null
  readonly providerPauseCode: string | null
  readonly providerPauseMessage: string | null
}

export interface DraftForTracking {
  readonly status: string
  readonly updatedAt: string
  readonly error: string | null
  readonly publishLeaseExpiresAt: string | null
  /**
   * Set once the draft has reached Shopify as a DRAFT product. That is a
   * finished handoff parked on purpose, not an abandoned draft — see
   * classifyDraft.
   */
  readonly shopifyProductId: string | null
}

export interface Classification {
  readonly group: TrackingGroup
  readonly tone: TrackingTone
  readonly statusLabel: string
  readonly reason: string
}

function ageMs(iso: string, now: number): number {
  return Math.max(0, now - new Date(iso).getTime())
}

export function classifyIntake(
  row: IntakeForTracking,
  now: number,
  duplicateFilename?: string,
): Classification {
  if (row.providerPausedAt !== null) {
    return {
      group: 'attention',
      tone: 'failed',
      statusLabel: 'Credits required',
      reason:
        row.providerPauseMessage ??
        'Enhancement is paused because the image provider account needs more credits. Add credits, then choose Resume enhancement. The source photo and retry budget are unchanged.',
    }
  }

  if (row.status === 'failed') {
    return {
      group: 'attention',
      tone: 'failed',
      statusLabel: 'Failed',
      reason: row.lastError ?? 'Enhancement failed. Open Details before deciding what to do.',
    }
  }

  if (duplicateFilename) {
    return {
      group: 'attention',
      tone: 'mismatch',
      statusLabel: 'Possible duplicate',
      reason: `Looks similar to ${duplicateFilename}. Review the pair; this warning does not block publishing.`,
    }
  }

  if (
    row.status === 'enhanced' &&
    row.productDraftId === null &&
    ageMs(row.discoveredAt, now) >= STALE_UNGROUPED_MS
  ) {
    const hours = Math.floor(ageMs(row.discoveredAt, now) / 3_600_000)
    return {
      group: 'attention',
      tone: 'stalled',
      statusLabel: 'Stalled',
      reason: `Enhanced but not grouped for ${hours} hours. Nothing failed; it may have been forgotten.`,
    }
  }

  if (
    (row.status === 'discovered' || row.status === 'enhancing') &&
    (
      ageMs(row.discoveredAt, now) >= STALE_PIPELINE_MS ||
      (
        row.status === 'enhancing' &&
        row.leaseExpiresAt !== null &&
        new Date(row.leaseExpiresAt).getTime() <= now
      )
    )
  ) {
    return {
      group: 'attention',
      tone: 'stalled',
      statusLabel: 'Stalled',
      reason:
        row.status === 'enhancing'
          ? 'Enhancement stopped making progress. The lease sweeper should recover it; check the event history.'
          : 'The photograph has waited over an hour without starting enhancement.',
    }
  }

  if (row.status === 'skipped') {
    return {
      group: 'progress',
      tone: 'running',
      statusLabel: 'On hold',
      reason:
        'You put this photograph aside. Resume it to send it back for enhancement, or discard it to remove it from Loupe and take it out of the RAW folder.',
    }
  }

  if (row.status === 'published' || row.status === 'duplicate') {
    return {
      group: 'complete',
      tone: 'complete',
      statusLabel: row.status === 'published' ? 'Published' : 'Duplicate',
      reason:
        row.status === 'published'
          ? 'Published to Shopify.'
          : 'An operator marked this photograph as a duplicate.',
    }
  }

  return {
    group: 'progress',
    tone: 'running',
    statusLabel:
      // "Enhanced" states the fact — the work finished and the photograph is in
      // the console. "Waiting" described what the OPERATOR still has to do and
      // read as though the pipeline had not finished.
      row.status === 'enhanced'
        ? 'Enhanced'
        : row.status === 'grouped'
          ? 'Draft'
          : row.status === 'enhancing'
            ? 'Enhancing'
            : 'Queued',
    reason:
      row.status === 'enhanced'
        ? 'Enhanced and ready in the console, waiting for an operator.'
        : row.status === 'grouped'
          ? 'Grouped into a product draft.'
          : row.status === 'enhancing'
            ? 'The enhancement worker owns this photograph.'
            : 'Waiting for the enhancement worker.',
  }
}

export function classifyDraft(row: DraftForTracking, now: number): Classification {
  if (row.status === 'failed') {
    return {
      group: 'attention',
      tone: 'failed',
      statusLabel: 'Publish failed',
      reason:
        row.error ??
        'Shopify publishing failed. Retrying from the console reuses the reserved product identity.',
    }
  }

  if (
    row.status === 'publishing' &&
    row.publishLeaseExpiresAt !== null &&
    new Date(row.publishLeaseExpiresAt).getTime() <= now
  ) {
    return {
      group: 'attention',
      tone: 'stalled',
      statusLabel: 'Publish interrupted',
      reason: 'The publish lease expired. Open the draft and retry; Loupe reuses the same handle.',
    }
  }

  /**
   * A draft that has NOT reached Shopify and has not moved for 24 hours was
   * probably forgotten. One that HAS reached Shopify is finished work waiting
   * for launch day, and Qimati's whole workflow is to accumulate those and
   * publish them together — so the old rule would have marked every correctly
   * drafted product as needing attention, permanently. See D90.
   *
   * `record_draft_shopify_product` deliberately returns the draft to
   * `assembling` (so the console can still edit it), which is why the status
   * alone cannot tell the two cases apart. `shopify_product_id` can.
   */
  if (
    row.status === 'assembling' &&
    row.shopifyProductId === null &&
    ageMs(row.updatedAt, now) >= STALE_DRAFT_MS
  ) {
    return {
      group: 'attention',
      tone: 'stalled',
      statusLabel: 'Draft stalled',
      reason:
        'This product draft has not changed for 24 hours and has never been sent to Shopify.',
    }
  }

  if (row.status === 'assembling' && row.shopifyProductId !== null) {
    return {
      group: 'draft',
      tone: 'running',
      statusLabel: 'In Shopify',
      reason:
        'Saved into Shopify as a draft product. It stays here until the launch, and needs nothing in the meantime.',
    }
  }

  if (row.status === 'published') {
    return {
      group: 'complete',
      tone: 'complete',
      statusLabel: 'Published',
      reason: 'Published to Shopify.',
    }
  }

  if (row.status === 'publishing') {
    return {
      group: 'progress',
      tone: 'running',
      statusLabel: 'Publishing',
      reason: 'Shopify publishing is in progress.',
    }
  }

  return {
    group: 'draft',
    tone: 'running',
    statusLabel: 'Draft',
    reason:
      'Saved as a draft. It exists in Shopify as a draft product and is waiting to be published.',
  }
}
