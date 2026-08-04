import 'server-only'

import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

import { enhancementConfig } from './config'
import { prepareModelInput } from './image'
import { OpenRouterClient } from './openrouter'
import { isPresentationClass } from './presentation'
import { resolveImagePrompt } from './prompt'
import { runRedoBatch } from './redo-worker'
import { R2ObjectStore } from './storage'
import { SupabaseRedoRepository } from './supabase-redo-repository'

interface IntakeRedoRow {
  source: string
  status: string
  mime_type: string
  product_description: string | null
  description_missing_at: string | null
  presentation_class: string | null
}

interface DescribePromptRow {
  id: string
  body: string
  model: string
}

interface OriginalVersionRow {
  storage_key: string | null
}

interface ImagePromptRow {
  uses_composition?: boolean | null
  id: string
  body: string
  model: string
}

function productionDependencies() {
  const openRouter = new OpenRouterClient(serverEnv.openRouterApiKey)
  return {
    repository: new SupabaseRedoRepository(),
    store: new R2ObjectStore({
      endpoint: serverEnv.r2Endpoint,
      accessKeyId: serverEnv.r2AccessKeyId,
      secretAccessKey: serverEnv.r2SecretAccessKey,
      bucket: serverEnv.r2Bucket,
    }),
    enhancer: openRouter,
    config: enhancementConfig(),
  }
}

/**
 * The exact prompt a redo WOULD send, without spending on the image call.
 *
 * A legacy photograph whose descriptor was permanently marked missing first
 * gets one current descriptor recovery call. The operator then reviews the
 * resolved image prompt and may edit it for this one product. Resolution is
 * shared with `queueImageRedo` so the preview cannot drift from what is sent.
 */
export async function previewRedoPrompt(
  intakeFileId: string,
): Promise<{ promptText: string; model: string }> {
  const { promptText, model } = await resolveRedo(intakeFileId)
  return { promptText, model }
}

/**
 * Prepare any photograph for a reliable AI redo.
 *
 * Manual ready uploads still bypass AI on ingest. A later explicit AI request
 * settles their redo state here. More importantly, old Drive photographs whose
 * descriptor failed used to remain permanently description-less: every redo
 * reused the generic flat-curve fallback even after the descriptor model and
 * prompt improved. Recover that missing identity record from the immutable R2
 * original before previewing or spending on a new image.
 */
export async function prepareImageRedo(
  intakeFileId: string,
  actor: string,
): Promise<boolean> {
  const db = supabaseServer()
  const { data: manualPrepared, error: manualError } = await db.rpc('prepare_manual_image_redo', {
    p_intake_file_id: intakeFileId,
    p_actor: actor,
  })
  if (manualError) throw new Error(manualError.hint || manualError.message)

  const fileResult = await db
    .from('intake_files')
    .select(
      'source, status, mime_type, product_description, description_missing_at, presentation_class',
    )
    .eq('id', intakeFileId)
    .maybeSingle<IntakeRedoRow>()
  if (fileResult.error || !fileResult.data) {
    throw new Error(fileResult.error?.message || 'That photograph is no longer available.')
  }
  const file = fileResult.data
  if (file.product_description) return manualPrepared === true
  if (!['enhanced', 'grouped'].includes(file.status)) {
    throw new Error('AI redo is available only after enhancement and before publishing.')
  }

  const [promptResult, originalResult] = await Promise.all([
    db
      .from('prompts')
      .select('id, body, model')
      .eq('kind', 'describe')
      .eq('is_default', true)
      .is('archived_at', null)
      .maybeSingle<DescribePromptRow>(),
    db
      .from('image_versions')
      .select('storage_key')
      .eq('intake_file_id', intakeFileId)
      .eq('version_no', 0)
      .eq('kind', 'original')
      .maybeSingle<OriginalVersionRow>(),
  ])
  if (promptResult.error || !promptResult.data) {
    throw new Error(promptResult.error?.message || 'There is no current descriptor prompt.')
  }
  if (originalResult.error || !originalResult.data?.storage_key) {
    throw new Error(
      originalResult.error?.message || 'The immutable original photograph is unavailable.',
    )
  }

  const dependencies = productionDependencies()
  const original = await dependencies.store.get(originalResult.data.storage_key)
  const prepared = await prepareModelInput(original)
  const result = await dependencies.enhancer.describe(
    prepared.buffer,
    prepared.mediaType,
    promptResult.data.body,
    {
      model: promptResult.data.model,
      reasoningEffort: dependencies.config.describeReasoningEffort,
    },
  )
  if (result.costUsd > dependencies.config.maxCostUsdPerDescription) {
    throw new Error(
      `The recovered product description cost $${result.costUsd.toFixed(6)}, above the ` +
        `$${dependencies.config.maxCostUsdPerDescription.toFixed(2)} safety ceiling. ` +
        'No image was generated.',
    )
  }

  const { error: storeError } = await db.rpc('store_redo_description', {
    p_intake_file_id: intakeFileId,
    p_description: result.text,
    p_presentation_class: result.presentation,
    p_model: result.model,
    p_cost_usd: result.costUsd,
    p_actor: actor,
  })
  if (storeError) throw new Error(storeError.hint || storeError.message)
  return manualPrepared === true
}

/** Backward-compatible name for callers deployed with the manual-only helper. */
export const prepareManualImageRedo = prepareImageRedo

async function resolveRedo(intakeFileId: string) {
  const db = supabaseServer()
  const [fileResult, promptResult] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'source, status, mime_type, product_description, description_missing_at, presentation_class',
      )
      .eq('id', intakeFileId)
      .maybeSingle<IntakeRedoRow>(),
    db
      .from('prompts')
      .select('id, body, model, uses_composition')
      .eq('kind', 'image')
      .eq('is_default', true)
      .is('archived_at', null)
      .maybeSingle<ImagePromptRow>(),
  ])
  if (fileResult.error || !fileResult.data) {
    throw new Error(fileResult.error?.message || 'That photograph is no longer available.')
  }
  if (promptResult.error || !promptResult.data) {
    throw new Error(promptResult.error?.message || 'There is no current image prompt.')
  }

  const file = fileResult.data
  const presentationClass = file.presentation_class
  if (!presentationClass || !isPresentationClass(presentationClass)) {
    throw new Error('This photograph has no reusable presentation class.')
  }
  const config = enhancementConfig()
  const resolved = resolveImagePrompt(
    promptResult.data.body,
    file.product_description,
    config.injectDescription,
    file.description_missing_at !== null,
    presentationClass,
    promptResult.data.uses_composition ?? true,
  )

  return {
    db,
    promptId: promptResult.data.id,
    model: promptResult.data.model,
    promptText: resolved.text,
    descriptionInjected: resolved.descriptionInjected,
    descriptionMissing: resolved.descriptionMissing,
  }
}

/**
 * A per-product prompt edit. Deliberately NOT a new prompt version: prompts are
 * immutable, versioned and audited (D51), and a one-off tweak for a single
 * photograph must never become the catalogue-wide default. The exact bytes
 * actually sent are still recorded on `image_versions.prompt_text` either way,
 * so a redo run from an edited prompt stays as traceable as any other.
 */
export async function queueImageRedo(
  intakeFileId: string,
  actor: string,
  promptOverride?: string | null,
): Promise<string> {
  const resolved = await resolveRedo(intakeFileId)

  const override = promptOverride?.trim() ? promptOverride : null
  if (override) {
    // The operator edits the RESOLVED prompt, so no template token should
    // survive. An unreplaced {{TOKEN}} would be sent to the image model as
    // literal text and quietly degrade the result.
    const leftover = override.match(/\{\{[A-Z_]+\}\}/gu)
    if (leftover) {
      throw new Error(
        `The edited prompt still contains ${[...new Set(leftover)].join(', ')}. ` +
          'Replace or remove it — the model would receive it as literal text.',
      )
    }
    if (override.length > 20_000) {
      throw new Error('The edited prompt is too long. Keep it under 20,000 characters.')
    }
  }

  return new SupabaseRedoRepository(resolved.db).enqueue({
    intakeFileId,
    promptId: resolved.promptId,
    promptText: override ?? resolved.promptText,
    promptOverride: override,
    descriptionInjected: resolved.descriptionInjected,
    descriptionMissing: resolved.descriptionMissing,
    actor,
  })
}

export function runProductionRedoBatch(jobId?: string) {
  return runRedoBatch(productionDependencies(), jobId)
}
