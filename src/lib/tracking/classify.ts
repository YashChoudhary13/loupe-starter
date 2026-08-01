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
}

export interface DraftForTracking {
  readonly status: string
  readonly updatedAt: string
  readonly error: string | null
  readonly publishLeaseExpiresAt: string | null
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

  if (row.status === 'assembling' && ageMs(row.updatedAt, now) >= STALE_DRAFT_MS) {
    return {
      group: 'attention',
      tone: 'stalled',
      statusLabel: 'Draft stalled',
      reason: 'This product draft has not changed for 24 hours.',
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

  return {
    group: 'progress',
    tone: 'running',
    statusLabel: row.status === 'publishing' ? 'Publishing' : 'Draft',
    reason:
      row.status === 'publishing'
        ? 'Shopify publishing is in progress.'
        : 'Saved product draft waiting for an operator.',
  }
}
