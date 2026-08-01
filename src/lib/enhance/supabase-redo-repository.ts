import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseServer } from '@/lib/supabase/server'

import type {
  RedoClaim,
  RedoCompletion,
  RedoFailure,
  RedoRepository,
} from './redo-repository'

interface ClaimRow {
  id: string
  intake_file_id: string
  source_version_id: string
  source_storage_key: string
  version_no: number
  prompt_id: string
  prompt_text: string
  model: string
  description_injected: boolean
  description_missing: boolean
  attempts: number
  lease_token: string
  lease_expires_at: string
  generation_started_at: string | null
}

interface CompletionRow {
  status: 'completed' | 'failed'
  image_version_id: string
  version_no: number
  cost_usd: number | string
}

interface FailureRow {
  status: 'queued' | 'failed'
  attempts: number
  next_attempt_at: string
}

function finiteNumber(value: number | string, field: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw new Error(`Redo database returned invalid ${field}.`)
  return number
}

export class SupabaseRedoRepository implements RedoRepository {
  constructor(private readonly db: SupabaseClient = supabaseServer()) {}

  async enqueue(input: Parameters<RedoRepository['enqueue']>[0]): Promise<string> {
    const { data, error } = await this.db.rpc('enqueue_image_redo', {
      p_intake_file_id: input.intakeFileId,
      p_prompt_id: input.promptId,
      p_prompt_text: input.promptText,
      p_description_injected: input.descriptionInjected,
      p_description_missing: input.descriptionMissing,
      p_actor: input.actor,
    })
    if (error || typeof data !== 'string') {
      throw new Error(error?.hint?.trim() || error?.message || 'Could not queue the image redo.')
    }

    // Recorded after the fact because enqueue_image_redo() predates this column
    // (Phase 5) and rewriting a committed SQL function to carry an audit flag
    // would be a heavier change than the flag is worth. What the model actually
    // receives is already correct either way — p_prompt_text above IS the
    // edited text. This only records that a human edited it, so a failure here
    // must not fail the redo the operator already asked for.
    if (input.promptOverride) {
      const { error: markError } = await this.db
        .from('image_redo_jobs')
        .update({ prompt_override: input.promptOverride })
        .eq('id', data)
      if (markError) {
        console.warn(`redo ${data}: prompt_override not recorded: ${markError.message}`)
      }
    }

    return data
  }

  async claim(leaseSeconds: number, jobId?: string): Promise<RedoClaim | null> {
    const { data, error } = await this.db
      .rpc('claim_image_redo', {
        p_lease_seconds: leaseSeconds,
        p_job_id: jobId ?? null,
      })
      .select()
      .maybeSingle<ClaimRow>()
    if (error) throw new Error(`Could not claim an image redo: ${error.message}`)
    if (!data) return null
    return {
      id: data.id,
      intakeFileId: data.intake_file_id,
      sourceVersionId: data.source_version_id,
      sourceStorageKey: data.source_storage_key,
      versionNo: data.version_no,
      promptId: data.prompt_id,
      promptText: data.prompt_text,
      model: data.model,
      descriptionInjected: data.description_injected,
      descriptionMissing: data.description_missing,
      attempts: data.attempts,
      leaseToken: data.lease_token,
      leaseExpiresAt: data.lease_expires_at,
      generationStartedAt: data.generation_started_at,
    }
  }

  async assertLease(jobId: string, leaseToken: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('assert_image_redo_lease', {
      p_job_id: jobId,
      p_lease_token: leaseToken,
    })
    if (error || typeof data !== 'boolean') {
      throw new Error(error?.message || 'Could not verify image redo ownership.')
    }
    return data
  }

  async markGenerationStarted(jobId: string, leaseToken: string): Promise<string> {
    const { data, error } = await this.db.rpc('mark_image_redo_generation_started', {
      p_job_id: jobId,
      p_lease_token: leaseToken,
    })
    if (error || typeof data !== 'string') {
      throw new Error(error?.message || 'Could not mark the image redo request as started.')
    }
    return data
  }

  async complete(input: Parameters<RedoRepository['complete']>[0]): Promise<RedoCompletion> {
    const { data, error } = await this.db
      .rpc('complete_image_redo', {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_storage_key: input.storageKey,
        p_thumb_key: input.thumbKey,
        p_width: input.width,
        p_height: input.height,
        p_actual_model: input.actualModel,
        p_cost_usd: input.costUsd,
        p_max_cost_usd: input.maxCostUsd,
        p_source: input.source,
      })
      .select()
      .single<CompletionRow>()
    if (error || !data) {
      throw new Error(error?.message || 'Could not complete the image redo.')
    }
    return {
      status: data.status,
      imageVersionId: data.image_version_id,
      versionNo: data.version_no,
      costUsd: finiteNumber(data.cost_usd, 'cost_usd'),
    }
  }

  async recordFailure(
    input: Parameters<RedoRepository['recordFailure']>[0],
  ): Promise<RedoFailure> {
    const { data, error } = await this.db
      .rpc('record_image_redo_failure', {
        p_job_id: input.jobId,
        p_lease_token: input.leaseToken,
        p_error: input.message,
        p_error_code: input.code,
        p_retryable: input.retryable,
        p_source: input.source,
      })
      .select()
      .single<FailureRow>()
    if (error || !data) {
      throw new Error(error?.message || 'Could not record the image redo failure.')
    }
    return {
      status: data.status,
      attempts: data.attempts,
      nextAttemptAt: data.next_attempt_at,
    }
  }
}
