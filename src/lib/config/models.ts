import 'server-only'

import { DESCRIBE_MODELS, IMAGE_MODELS } from '@/lib/prompts/models'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * D121 — operator-selectable pipeline models.
 *
 * The four pipeline stages read their model from the `app_config` table first
 * and fall back to the code default, so the /models section can retarget a
 * stage without a deploy. Values are validated against the curated lists on
 * write AND on read — a row edited out-of-band to an uncurated slug is ignored
 * rather than sent to a provider.
 *
 * Scope note: the describe/image choices apply to pairs materialised AFTER the
 * change (ensure-pair refreshes a stale pair on the next categorised upload).
 * The checker and art director read their model on every call, so those apply
 * immediately.
 */

export type PipelineStageKey =
  | 'describe_model'
  | 'image_model'
  | 'check_model'
  | 'art_director_model'

export interface PipelineStageDefinition {
  readonly key: PipelineStageKey
  readonly label: string
  readonly fallback: string
  /** Which curated list constrains the choice. */
  readonly kind: 'describe' | 'image'
}

/**
 * The checker and art director are chat-vision calls, so they choose from the
 * describe list. Their code defaults mirror the D120 research picks.
 */
export const PIPELINE_STAGES: readonly PipelineStageDefinition[] = [
  {
    key: 'art_director_model',
    label: 'Art director',
    fallback: 'google/gemini-3.5-flash-lite',
    kind: 'describe',
  },
  {
    key: 'describe_model',
    label: 'Describer',
    fallback: 'google/gemini-3.5-flash',
    kind: 'describe',
  },
  {
    key: 'image_model',
    label: 'Image model',
    fallback: 'google/gemini-3.1-flash-image',
    kind: 'image',
  },
  {
    key: 'check_model',
    label: 'Checker',
    fallback: 'google/gemini-3.6-flash',
    kind: 'describe',
  },
] as const

function stage(key: PipelineStageKey): PipelineStageDefinition {
  const found = PIPELINE_STAGES.find((candidate) => candidate.key === key)
  if (!found) throw new Error(`Unknown pipeline stage "${key}".`)
  return found
}

export function isCuratedFor(key: PipelineStageKey, model: string): boolean {
  const list = stage(key).kind === 'image' ? IMAGE_MODELS : DESCRIBE_MODELS
  return list.some((candidate) => candidate.id === model)
}

/**
 * Read one stage's configured model. Never throws: any read problem or
 * uncurated stored value falls back to the code default — configuration must
 * not be able to stop the pipeline.
 */
export async function configuredModel(
  key: PipelineStageKey,
  fallback?: string,
): Promise<string> {
  const safe = fallback ?? stage(key).fallback
  try {
    const { data, error } = await supabaseServer()
      .from('app_config')
      .select('value')
      .eq('key', key)
      .maybeSingle<{ value: string }>()
    if (error || !data?.value) return safe
    return isCuratedFor(key, data.value) ? data.value : safe
  } catch {
    return safe
  }
}

export interface PipelineModelChoice {
  readonly key: PipelineStageKey
  readonly model: string
  readonly isDefault: boolean
  readonly updatedAt: string | null
  readonly updatedBy: string | null
}

export async function pipelineModelChoices(): Promise<readonly PipelineModelChoice[]> {
  const { data, error } = await supabaseServer()
    .from('app_config')
    .select('key, value, updated_at, updated_by')
    .in(
      'key',
      PIPELINE_STAGES.map((definition) => definition.key),
    )
  if (error) throw new Error(`app_config: ${error.message}`)
  const rows = (data ?? []) as {
    key: string
    value: string
    updated_at: string
    updated_by: string
  }[]
  return PIPELINE_STAGES.map((definition) => {
    const row = rows.find((candidate) => candidate.key === definition.key)
    const stored = row && isCuratedFor(definition.key, row.value) ? row.value : null
    return {
      key: definition.key,
      model: stored ?? definition.fallback,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    }
  })
}

/** Validates, upserts and audits one stage's model choice. */
export async function setPipelineModel(
  key: PipelineStageKey,
  model: string,
  actor: string,
): Promise<void> {
  const definition = stage(key)
  const trimmed = model.trim()
  if (!isCuratedFor(key, trimmed)) {
    throw new Error(`"${trimmed}" is not a curated ${definition.kind} model.`)
  }
  const db = supabaseServer()
  const { error } = await db.from('app_config').upsert({
    key,
    value: trimmed,
    updated_at: new Date().toISOString(),
    updated_by: actor,
  })
  if (error) throw new Error(`app_config write: ${error.message}`)
  await db
    .from('events')
    .insert({
      entity_type: 'system',
      entity_id: null,
      event: 'pipeline.model_changed',
      detail: { stage: key, model: trimmed },
      actor,
    })
    .then(({ error: eventError }) => {
      // Audit is best-effort; the change itself already landed.
      if (eventError) console.warn(`pipeline.model_changed event: ${eventError.message}`)
    })
}
