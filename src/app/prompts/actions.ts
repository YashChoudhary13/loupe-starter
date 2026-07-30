'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireOperatorForAction } from '@/lib/auth/authorize'
import type { PromptKind } from '@/lib/enhance/repository'
import { isCuratedModel } from '@/lib/prompts/models'
import { supabaseServer } from '@/lib/supabase/server'

function returnToPrompts(key: 'updated' | 'error', value: string): never {
  redirect(`/prompts?${key}=${encodeURIComponent(value)}`)
}

export async function selectPromptModelAction(formData: FormData): Promise<void> {
  const operator = await requireOperatorForAction()
  const kind = String(formData.get('kind') ?? '') as PromptKind
  const model = String(formData.get('model') ?? '').trim()

  if (!['describe', 'image'].includes(kind) || !isCuratedModel(kind, model)) {
    returnToPrompts('error', 'That model is not in Loupe’s curated list.')
  }

  const { error } = await supabaseServer().rpc('select_prompt_model', {
    p_kind: kind,
    p_model: model,
    p_actor: operator.email,
  })
  if (error) {
    returnToPrompts(
      'error',
      error.hint?.trim() || 'The model could not be changed. Try again.',
    )
  }

  revalidatePath('/prompts')
  returnToPrompts('updated', kind)
}
