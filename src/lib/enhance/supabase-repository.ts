import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseServer } from '@/lib/supabase/server'

import {
  type CompletionInput,
  type DescriptionCache,
  type DescriptionFailureResult,
  type EnhancementClaim,
  type EnhancementCompletion,
  type EnhancementRepository,
  EnhancementRepositoryError,
  type IntakeFailureInput,
  type IntakeFailureResult,
  type LivePrompt,
  type LivePrompts,
  type PresentationCache,
  type ProviderQuotaPauseResult,
} from './repository'
import type { PresentationClass } from './presentation'

interface ClaimRow {
  id: string
  drive_file_id: string
  filename: string
  drive_md5: string | null
  bytes: number | string | null
  mime_type: string | null
  attempts: number
  lease_token: string | null
  lease_expires_at: string | null
  product_description: string | null
  presentation_class: PresentationClass | null
  presentation_fallback: boolean
  presentation_fallback_reason: string | null
  description_model: string | null
  described_at: string | null
  description_cost_usd: number | string | null
  description_missing_at: string | null
}

interface DescriptionRow {
  product_description: string
  presentation_class: PresentationClass
  presentation_fallback: false
  presentation_fallback_reason: null
  description_model: string
  described_at: string
  description_cost_usd: number | string
}

interface DescriptionFailureRow {
  status: 'discovered' | 'enhancing'
  attempts: number
  next_attempt_at: string
  proceed_without_description: boolean
  presentation_class: PresentationClass | null
  presentation_fallback: boolean
  presentation_fallback_reason: string | null
}

interface PresentationRow {
  presentation_class: PresentationClass
  presentation_fallback: boolean
  presentation_fallback_reason: string | null
}

interface CompletionRow {
  status: 'enhanced' | 'failed'
  attempts: number
  image_version_id: string
  version_no: number
  cost_usd: number | string
}

interface FailureRow {
  status: 'discovered' | 'failed'
  attempts: number
  next_attempt_at: string
}

interface ProviderQuotaPauseRow {
  status: 'discovered'
  attempts: number
  provider_paused_at: string
}

function dbError(message: string, detail: unknown): EnhancementRepositoryError {
  return new EnhancementRepositoryError(message, { retryable: true, detail })
}

function finiteNumber(value: number | string | null, field: string): number | null {
  if (value === null) return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) {
    throw new EnhancementRepositoryError(`Database returned invalid ${field}.`, {
      retryable: false,
      detail: value,
    })
  }
  return number
}

export class SupabaseEnhancementRepository implements EnhancementRepository {
  constructor(private readonly db: SupabaseClient = supabaseServer()) {}

  async claim(leaseSeconds: number): Promise<EnhancementClaim | null> {
    const { data, error } = await this.db
      .rpc('claim_intake_file', { p_lease_seconds: leaseSeconds })
      .select()
      .maybeSingle<ClaimRow>()
    if (error) throw dbError('Could not claim an intake file for enhancement.', error)
    if (!data) return null
    if (!data.lease_token || !data.lease_expires_at || !data.mime_type) {
      throw new EnhancementRepositoryError('The intake claim returned incomplete ownership data.', {
        retryable: false,
        detail: data,
      })
    }
    return {
      id: data.id,
      driveFileId: data.drive_file_id,
      filename: data.filename,
      driveMd5: data.drive_md5,
      bytes: finiteNumber(data.bytes, 'bytes'),
      mimeType: data.mime_type,
      attempts: data.attempts,
      leaseToken: data.lease_token,
      leaseExpiresAt: data.lease_expires_at,
      productDescription: data.product_description,
      presentationClass: data.presentation_class,
      presentationFallback: data.presentation_fallback,
      presentationFallbackReason: data.presentation_fallback_reason,
      descriptionModel: data.description_model,
      describedAt: data.described_at,
      descriptionCostUsd: finiteNumber(data.description_cost_usd, 'description_cost_usd'),
      descriptionMissingAt: data.description_missing_at,
    }
  }

  async storePerceptualHash(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly phash: string
    readonly source: string
  }): Promise<string> {
    const { data, error } = await this.db.rpc('store_intake_phash', {
      p_intake_file_id: input.intakeFileId,
      p_lease_token: input.leaseToken,
      p_phash: input.phash,
      p_source: input.source,
    })
    if (error) throw dbError('Could not store the source perceptual hash.', error)
    if (typeof data !== 'string') {
      throw new EnhancementRepositoryError('The perceptual-hash write returned no hash.', {
        retryable: false,
        detail: data,
      })
    }
    return data
  }

  async assertLease(intakeFileId: string, leaseToken: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('assert_intake_lease', {
      p_intake_file_id: intakeFileId,
      p_lease_token: leaseToken,
    })
    if (error) throw dbError(`Could not verify enhancement ownership for ${intakeFileId}.`, error)
    if (typeof data !== 'boolean') {
      throw new EnhancementRepositoryError('The intake lease check returned an invalid result.', {
        retryable: false,
        detail: data,
      })
    }
    return data
  }

  async loadLivePrompts(): Promise<LivePrompts> {
    const { data, error } = await this.db
      .from('prompts')
      .select('id, name, kind, body, model, uses_composition')
      .eq('is_default', true)
      .is('archived_at', null)
      .in('kind', ['describe', 'image'])
    if (error) throw dbError('Could not load the live enhancement prompts.', error)

    // Mapped, not cast: the column is uses_composition and the domain type is
    // usesComposition, so a straight cast would silently leave it undefined —
    // which reads as falsy and would strip the composition from every prompt.
    const rows: LivePrompt[] = ((data ?? []) as {
      id: string
      name: string
      kind: LivePrompt['kind']
      body: string
      model: string
      uses_composition: boolean | null
    }[]).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      body: row.body,
      model: row.model,
      usesComposition: row.uses_composition ?? true,
    }))
    const describe = rows.filter((row) => row.kind === 'describe')
    const image = rows.filter((row) => row.kind === 'image')
    if (describe.length !== 1 || image.length !== 1) {
      throw new EnhancementRepositoryError(
        `Expected exactly one live default prompt of each kind; found describe=${describe.length}, image=${image.length}.`,
        { retryable: false, detail: rows },
      )
    }
    return { describe: describe[0]!, image: image[0]! }
  }

  async storeDescription(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly description: string
    readonly presentationClass: PresentationClass
    readonly model: string
    readonly costUsd: number
    readonly source: string
  }): Promise<DescriptionCache> {
    const { data, error } = await this.db
      .rpc('store_intake_description', {
        p_intake_file_id: input.intakeFileId,
        p_lease_token: input.leaseToken,
        p_description: input.description,
        p_presentation_class: input.presentationClass,
        p_model: input.model,
        p_cost_usd: input.costUsd,
        p_source: input.source,
      })
      .select()
      .single<DescriptionRow>()
    if (error || !data) {
      throw dbError(`Could not store the description for ${input.intakeFileId}.`, error ?? data)
    }
    return {
      text: data.product_description,
      presentationClass: data.presentation_class,
      presentationFallback: data.presentation_fallback,
      presentationFallbackReason: data.presentation_fallback_reason,
      model: data.description_model,
      describedAt: data.described_at,
      costUsd: finiteNumber(data.description_cost_usd, 'description_cost_usd')!,
    }
  }

  async ensurePresentationFallback(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly reason: string
    readonly source: string
  }): Promise<PresentationCache> {
    const { data, error } = await this.db
      .rpc('ensure_intake_presentation_fallback', {
        p_intake_file_id: input.intakeFileId,
        p_lease_token: input.leaseToken,
        p_reason: input.reason,
        p_source: input.source,
      })
      .select()
      .single<PresentationRow>()
    if (error || !data) {
      throw dbError(
        `Could not store the presentation fallback for ${input.intakeFileId}.`,
        error ?? data,
      )
    }
    return {
      presentationClass: data.presentation_class,
      presentationFallback: data.presentation_fallback,
      presentationFallbackReason: data.presentation_fallback_reason,
    }
  }

  async recordDescriptionFailure(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly message: string
    readonly code: string
    readonly detail: string
    readonly source: string
  }): Promise<DescriptionFailureResult> {
    const { data, error } = await this.db
      .rpc('record_description_failure', {
        p_intake_file_id: input.intakeFileId,
        p_lease_token: input.leaseToken,
        p_error: input.message,
        p_error_code: input.code,
        p_error_detail: input.detail,
        p_source: input.source,
      })
      .select()
      .single<DescriptionFailureRow>()
    if (error || !data) {
      throw dbError(
        `Could not record the description failure for ${input.intakeFileId}.`,
        error ?? data,
      )
    }
    return {
      status: data.status,
      attempts: data.attempts,
      nextAttemptAt: data.next_attempt_at,
      proceedWithoutDescription: data.proceed_without_description,
      presentationClass: data.presentation_class,
      presentationFallback: data.presentation_fallback,
      presentationFallbackReason: data.presentation_fallback_reason,
    }
  }

  async complete(input: CompletionInput): Promise<EnhancementCompletion> {
    const { data, error } = await this.db
      .rpc('complete_intake_enhancement', {
        p_intake_file_id: input.intakeFileId,
        p_lease_token: input.leaseToken,
        p_original_storage_key: input.originalStorageKey,
        p_original_width: input.originalWidth,
        p_original_height: input.originalHeight,
        p_generated_storage_key: input.generatedStorageKey,
        p_thumb_key: input.thumbKey,
        p_generated_width: input.generatedWidth,
        p_generated_height: input.generatedHeight,
        p_model: input.model,
        p_prompt_text: input.promptText,
        p_cost_usd: input.costUsd,
        p_max_cost_usd: input.maxCostUsd,
        p_description_injected: input.descriptionInjected,
        p_description_missing: input.descriptionMissing,
        p_source: input.source,
      })
      .select()
      .single<CompletionRow>()
    if (error || !data) {
      throw dbError(`Could not complete enhancement for ${input.intakeFileId}.`, error ?? data)
    }
    return {
      status: data.status,
      attempts: data.attempts,
      imageVersionId: data.image_version_id,
      versionNo: data.version_no,
      costUsd: finiteNumber(data.cost_usd, 'cost_usd')!,
    }
  }

  async recordFailure(input: IntakeFailureInput): Promise<IntakeFailureResult> {
    const { data, error } = await this.db
      .rpc('record_intake_failure', {
        p_intake_file_id: input.intakeFileId,
        p_lease_token: input.leaseToken,
        p_error: input.message,
        p_error_code: input.code,
        p_error_class: input.retryable ? 'retryable' : 'permanent',
        p_error_detail: input.detail,
        p_source: input.source,
      })
      .select()
      .single<FailureRow>()
    if (error || !data) {
      throw dbError(`Could not record enhancement failure for ${input.intakeFileId}.`, error ?? data)
    }
    return {
      status: data.status,
      attempts: data.attempts,
      nextAttemptAt: data.next_attempt_at,
    }
  }

  async pauseForProviderQuota(input: {
    readonly intakeFileId: string
    readonly leaseToken: string
    readonly message: string
    readonly code: string
    readonly detail: string
    readonly stage: string
    readonly source: string
  }): Promise<ProviderQuotaPauseResult> {
    const { data, error } = await this.db
      .rpc('pause_intake_for_provider_quota', {
        p_intake_file_id: input.intakeFileId,
        p_lease_token: input.leaseToken,
        p_error: input.message,
        p_error_code: input.code,
        p_error_detail: input.detail,
        p_stage: input.stage,
        p_source: input.source,
      })
      .select()
      .single<ProviderQuotaPauseRow>()
    if (error || !data) {
      throw dbError(
        `Could not pause enhancement for provider quota on ${input.intakeFileId}.`,
        error ?? data,
      )
    }
    return {
      status: data.status,
      attempts: data.attempts,
      providerPausedAt: data.provider_paused_at,
    }
  }

  async recordSystemEvent(input: {
    readonly event: string
    readonly detail: Record<string, unknown>
    readonly actor: string
  }): Promise<void> {
    const { error } = await this.db.from('events').insert({
      entity_type: 'system',
      entity_id: null,
      event: input.event,
      detail: input.detail,
      actor: input.actor,
    })
    if (error) {
      throw dbError(`Could not record system event "${input.event}".`, error)
    }
  }
}
