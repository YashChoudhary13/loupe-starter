import 'server-only'

import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

import { enhancementConfig } from './config'
import { OpenRouterClient } from './openrouter'
import { isPresentationClass } from './presentation'
import { resolveImagePrompt } from './prompt'
import { runRedoBatch } from './redo-worker'
import { R2ObjectStore } from './storage'
import { SupabaseRedoRepository } from './supabase-redo-repository'

interface IntakeRedoRow {
  status: string
  product_description: string | null
  description_missing_at: string | null
  presentation_class: string | null
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
 * The exact prompt a redo WOULD send, without spending anything.
 *
 * The operator reviews this before the paid call, and may edit it for this one
 * product. Resolution is shared with `queueImageRedo` so the preview cannot
 * drift from what is actually sent.
 */
export async function previewRedoPrompt(
  intakeFileId: string,
): Promise<{ promptText: string; model: string }> {
  const { promptText, model } = await resolveRedo(intakeFileId)
  return { promptText, model }
}

async function resolveRedo(intakeFileId: string) {
  const db = supabaseServer()
  const [fileResult, promptResult] = await Promise.all([
    db
      .from('intake_files')
      .select('status, product_description, description_missing_at, presentation_class')
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
