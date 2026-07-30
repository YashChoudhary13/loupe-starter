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

export async function queueImageRedo(intakeFileId: string, actor: string): Promise<string> {
  const db = supabaseServer()
  const [fileResult, promptResult] = await Promise.all([
    db
      .from('intake_files')
      .select('status, product_description, description_missing_at, presentation_class')
      .eq('id', intakeFileId)
      .maybeSingle<IntakeRedoRow>(),
    db
      .from('prompts')
      .select('id, body, model')
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
  )

  return new SupabaseRedoRepository(db).enqueue({
    intakeFileId,
    promptId: promptResult.data.id,
    promptText: resolved.text,
    descriptionInjected: resolved.descriptionInjected,
    descriptionMissing: resolved.descriptionMissing,
    actor,
  })
}

export function runProductionRedoBatch(jobId?: string) {
  return runRedoBatch(productionDependencies(), jobId)
}
