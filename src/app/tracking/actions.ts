'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { loadDuplicateCandidates } from '@/lib/duplicates/read-model'
import { supabaseServer } from '@/lib/supabase/server'
import { loadTracking } from '@/lib/tracking/read-model'
import type { TrackingSnapshot } from '@/lib/tracking/types'

export type TrackingActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly detail: string | null }

function message(cause: unknown): TrackingActionResult<never> {
  if (cause instanceof NotAuthorisedError) {
    return { ok: false, error: cause.message, detail: null }
  }
  const detail = cause instanceof Error ? cause.message : String(cause)
  console.error('tracking action failed:', detail)
  return {
    ok: false,
    error: 'That change was not saved. Reload Tracking and try again.',
    detail,
  }
}

async function withOperator<T>(
  run: (email: string) => Promise<T>,
): Promise<TrackingActionResult<T>> {
  try {
    const operator = await requireOperatorForAction()
    return { ok: true, data: await run(operator.email) }
  } catch (cause) {
    return message(cause)
  }
}

export async function refreshTrackingAction(): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(() => loadTracking())
}

export async function retryIntakeAction(
  intakeFileId: string,
): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(async (email) => {
    const { error } = await supabaseServer().rpc('retry_intake_file', {
      p_intake_file_id: intakeFileId,
      p_actor: email,
    })
    if (error) throw new Error(error.hint || error.message)
    return loadTracking()
  })
}

export async function skipIntakeAction(
  intakeFileId: string,
): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(async (email) => {
    const { error } = await supabaseServer().rpc('skip_intake_file', {
      p_intake_file_id: intakeFileId,
      p_actor: email,
    })
    if (error) throw new Error(error.hint || error.message)
    return loadTracking()
  })
}

/** Puts a held photograph back in the enhancement queue with a clean retry budget. */
export async function resumeIntakeAction(
  intakeFileId: string,
): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(async (email) => {
    const { error } = await supabaseServer().rpc('resume_intake_file', {
      p_intake_file_id: intakeFileId,
      p_actor: email,
    })
    if (error) throw new Error(error.hint || error.message)
    return loadTracking()
  })
}

/** Releases an account-credit pause and nudges enhancement immediately. */
export async function resumeProviderPausedIntakeAction(
  intakeFileId: string,
): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(async (email) => {
    const { error } = await supabaseServer().rpc('resume_provider_paused_intake_file', {
      p_intake_file_id: intakeFileId,
      p_actor: email,
    })
    if (error) throw new Error(error.hint || error.message)

    // Best-effort latency optimisation. The minute cron remains the durable
    // fallback if this request cannot be sent.
    const { nudgeEnhanceCron } = await import('@/lib/cron/jobs')
    await nudgeEnhanceCron()
    return loadTracking()
  })
}

/**
 * Discards a held photograph for good.
 *
 * Order matters and is deliberate: a Drive source leaves RAW first (a manual
 * source has no Drive object), then the R2 objects are removed, and only then is
 * the database row deleted. Every step before the last is idempotent, so a
 * failure part-way leaves the row intact and the operator can simply press
 * Discard again. Reversing the Drive order would strand a file in RAW that Loupe
 * no longer knows about — the watcher would rediscover it minutes later and it
 * would reappear in the queue.
 *
 * A Drive file is MOVED to /Discarded rather than trashed: Phase 4 proved the
 * service account cannot trash files owned by the operator's own Drive. Moving
 * it out of RAW is what actually matters — it stops being rescanned — and the
 * owner can empty /Discarded themselves. Manual uploads skip Drive completely.
 */
export async function discardIntakeAction(
  intakeFileId: string,
): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(async (email) => {
    const { discardHeldIntake } = await import('@/lib/tracking/discard')
    await discardHeldIntake(intakeFileId, email)
    return loadTracking()
  })
}

export async function reviewDuplicateAction(input: {
  readonly intakeFileId: string
  readonly matchIntakeFileId: string
  readonly decision: 'dismissed' | 'duplicate'
}): Promise<TrackingActionResult<TrackingSnapshot>> {
  return withOperator(async (email) => {
    // Re-read the current candidate and distance. IDs from a server action are
    // requests, never proof that a pair is still reviewable.
    const candidates = await loadDuplicateCandidates([input.intakeFileId])
    const candidate = candidates.find(
      (row) =>
        row.intakeFileId === input.intakeFileId &&
        row.matchIntakeFileId === input.matchIntakeFileId,
    )
    if (!candidate) {
      throw new Error('That duplicate warning has already been reviewed or is no longer current.')
    }

    const { error } = await supabaseServer().rpc('review_duplicate_pair', {
      p_left_intake_file_id: input.intakeFileId,
      p_right_intake_file_id: input.matchIntakeFileId,
      p_decision: input.decision,
      p_duplicate_intake_file_id:
        input.decision === 'duplicate' ? input.intakeFileId : null,
      p_distance: candidate.distance,
      p_actor: email,
    })
    if (error) throw new Error(error.hint || error.message)
    return loadTracking()
  })
}

export async function runFullReconciliationAction(): Promise<
  TrackingActionResult<{
    snapshot: TrackingSnapshot
    started: boolean
    runId: string
    totalProducts: number
    matchedProducts: number
    issueCount: number
    promotedProducts: number
    deletedShopifyDrafts: number
    promotionFailures: number
    promotionError: string | null
    skuCounters: {
      variantsScanned: number
      countersChecked: number
      raised: readonly { prefix: string; from: number; to: number }[]
      blankSkus: number
      unparseableSkus: number
      excludedMalformedSkus: number
      unknownPrefixes: readonly { prefix: string; max: number; count: number }[]
    }
  }>
> {
  return withOperator(async (email) => {
    const [{ promotePublishedInShopify }, { runShopifyReconciliation }, { syncSkuCountersFromShopify }] =
      await Promise.all([
        import('@/lib/reconciliation/promote'),
        import('@/lib/reconciliation/server'),
        import('@/lib/reconciliation/sync-sku-counters'),
      ])

    let promotedProducts = 0
    let deletedShopifyDrafts = 0
    let promotionFailures = 0
    let promotionError: string | null = null
    try {
      const promotion = await promotePublishedInShopify(email)
      promotedProducts = promotion.promoted.length
      deletedShopifyDrafts = promotion.deleted.length
      promotionFailures = promotion.failures.length
    } catch (cause) {
      // Match the daily job: promotion is useful, but a transient failure must
      // not suppress the catalogue drift report or the safe counter scan.
      promotionError = cause instanceof Error ? cause.message : String(cause)
    }

    const reconciliation = await runShopifyReconciliation(email)
    const skuCounters = await syncSkuCountersFromShopify(email)
    return {
      snapshot: await loadTracking(),
      started: reconciliation.started,
      runId: reconciliation.runId,
      totalProducts: reconciliation.totalProducts,
      matchedProducts: reconciliation.matchedProducts,
      issueCount: reconciliation.issueCount,
      promotedProducts,
      deletedShopifyDrafts,
      promotionFailures,
      promotionError,
      skuCounters,
    }
  })
}
