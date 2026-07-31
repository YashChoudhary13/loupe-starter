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

export async function runReconciliationAction(): Promise<
  TrackingActionResult<{ snapshot: TrackingSnapshot; started: boolean; runId: string }>
> {
  return withOperator(async (email) => {
    const { runShopifyReconciliation } = await import('@/lib/reconciliation/server')
    const result = await runShopifyReconciliation(email)
    return {
      snapshot: await loadTracking(),
      started: result.started,
      runId: result.runId,
    }
  })
}
