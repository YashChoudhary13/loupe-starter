'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import { nudgeEnhanceCron } from '@/lib/cron/jobs'
import {
  beginManualUpload,
  finalizeIdentifyUpload,
  type BeginManualUploadInput,
  type ManualUploadTicket,
} from '@/lib/manual-upload/server'
import { loadIdentifyQueue, type IdentifySnapshot } from '@/lib/match/read-model'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * D110 — the Identify screen's actions. Every decision is one RPC that refuses
 * to run twice; the screen re-reads the queue after each.
 */

export type IdentifyActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly detail: string | null; readonly retryable: boolean }

async function withOperator<T>(
  run: (email: string) => Promise<T>,
): Promise<IdentifyActionResult<T>> {
  try {
    const operator = await requireOperatorForAction()
    return { ok: true, data: await run(operator.email) }
  } catch (cause) {
    if (cause instanceof NotAuthorisedError) {
      return { ok: false, error: cause.message, detail: null, retryable: false }
    }
    if (cause instanceof ConsoleError) {
      return { ok: false, error: cause.operatorMessage, detail: cause.detail, retryable: cause.retryable }
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.error('identify action failed:', detail)
    return { ok: false, error: 'That did not work and nothing was changed. Reload Identify and try again.', detail, retryable: true }
  }
}

export async function refreshIdentifyAction(): Promise<IdentifyActionResult<IdentifySnapshot>> {
  return withOperator(() => loadIdentifyQueue())
}

export type IntakeDecision = 'new_product' | 'restock' | 'skipped'
export type IdentifyDecision = 'confirmed' | 'none_of_these'

export async function decideIntakeAction(input: {
  readonly matchEventId: string
  readonly decision: IntakeDecision
  readonly sku: string | null
  readonly rank: number | null
}): Promise<IdentifyActionResult<IdentifySnapshot>> {
  return withOperator(async (email) => {
    const { error } = await supabaseServer().rpc('decide_identification', {
      p_match_event_id: input.matchEventId,
      p_decision: input.decision,
      p_sku: input.sku,
      p_rank: input.rank,
      p_actor: email,
    })
    if (error) throw new ConsoleError(error.hint || error.message, error.message, false)
    // A new product starts enhancing now rather than on the next minute boundary.
    if (input.decision !== 'restock') await nudgeEnhanceCron()
    return loadIdentifyQueue()
  })
}

export async function confirmIdentifyAction(input: {
  readonly matchEventId: string
  readonly decision: IdentifyDecision
  readonly sku: string | null
  readonly rank: number | null
}): Promise<IdentifyActionResult<IdentifySnapshot>> {
  return withOperator(async (email) => {
    const { error } = await supabaseServer().rpc('confirm_identification', {
      p_match_event_id: input.matchEventId,
      p_decision: input.decision,
      p_sku: input.sku,
      p_rank: input.rank,
      p_actor: email,
    })
    if (error) throw new ConsoleError(error.hint || error.message, error.message, false)
    return loadIdentifyQueue()
  })
}

export async function beginIdentifyUploadAction(
  input: BeginManualUploadInput,
): Promise<IdentifyActionResult<ManualUploadTicket>> {
  return withOperator(async () => {
    const operator = await requireOperatorForAction()
    return beginManualUpload(operator, input, 'identify')
  })
}

export async function finalizeIdentifyUploadAction(input: {
  readonly uploadId: string
}): Promise<IdentifyActionResult<{ matchEventId: string }>> {
  return withOperator(async () => {
    const operator = await requireOperatorForAction()
    const matchEventId = await finalizeIdentifyUpload(operator, input.uploadId)
    return { matchEventId }
  })
}
