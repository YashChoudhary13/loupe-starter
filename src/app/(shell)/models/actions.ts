'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireOperatorForAction } from '@/lib/auth/authorize'
import {
  PIPELINE_STAGES,
  setPipelineModel,
  type PipelineStageKey,
} from '@/lib/config/models'

function returnToModels(key: 'saved' | 'error', value: string): never {
  redirect(`/models?${key}=${encodeURIComponent(value)}`)
}

export async function setPipelineModelAction(formData: FormData): Promise<void> {
  const operator = await requireOperatorForAction()
  const stage = String(formData.get('stage') ?? '')
  const model = String(formData.get('model') ?? '').trim()

  const definition = PIPELINE_STAGES.find((candidate) => candidate.key === stage)
  if (!definition) returnToModels('error', 'That pipeline stage does not exist.')

  try {
    await setPipelineModel(definition.key as PipelineStageKey, model, operator.email)
  } catch (cause) {
    returnToModels('error', cause instanceof Error ? cause.message : 'The model could not be saved.')
  }

  revalidatePath('/models')
  returnToModels('saved', definition.label)
}
