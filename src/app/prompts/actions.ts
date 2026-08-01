'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireOperatorForAction } from '@/lib/auth/authorize'
import type { PromptKind } from '@/lib/enhance/repository'
import { isCuratedModel } from '@/lib/prompts/models'
import { supabaseServer } from '@/lib/supabase/server'

function returnToPrompts(
  key: 'updated' | 'created' | 'promoted' | 'preset' | 'error',
  value: string,
): never {
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

export async function createPromptVersionAction(formData: FormData): Promise<void> {
  const operator = await requireOperatorForAction()
  const kind = String(formData.get('kind') ?? '') as PromptKind
  const name = String(formData.get('name') ?? '').trim()
  const body = String(formData.get('body') ?? '')
  const model = String(formData.get('model') ?? '').trim()

  if (!['describe', 'image'].includes(kind) || !isCuratedModel(kind, model)) {
    returnToPrompts('error', 'Choose a model from Loupe’s curated list.')
  }
  if (!name || name.length > 160) {
    returnToPrompts('error', 'Give this prompt version a name of 160 characters or fewer.')
  }
  if (!body.trim() || body.length > 20_000) {
    returnToPrompts('error', 'The prompt must contain 1–20,000 characters.')
  }

  const db = supabaseServer()
  const { data, error } = await db.rpc('create_prompt_version', {
    p_kind: kind,
    p_name: name,
    p_body: body,
    p_model: model,
    p_actor: operator.email,
  })
  if (error) {
    returnToPrompts(
      'error',
      error.hint?.trim() || error.message || 'The prompt version could not be saved.',
    )
  }

  // Whether an image prompt lets the describer choose the pose is DERIVED from
  // the body, so a deleted composition token quietly changes what the prompt
  // means. Read the result back and say which one was saved, rather than letting
  // the operator find out three hundred photographs later.
  let staging: 'composed' | 'self' | null = null
  if (kind === 'image' && typeof data === 'string') {
    const { data: saved } = await db
      .from('prompts')
      .select('uses_composition')
      .eq('id', data)
      .maybeSingle<{ uses_composition: boolean }>()
    if (saved) staging = saved.uses_composition ? 'composed' : 'self'
  }

  revalidatePath('/prompts')
  returnToPrompts('created', staging ? `${kind}:${staging}` : kind)
}

/**
 * Applies a saved style preset: both the describer and the image prompt move to
 * that preset in one transaction. Promoting only the image half would leave the
 * describer writing about a piece laid flat on a surface while the image prompt
 * stands it on a hand.
 */
export async function promptPresetAction(formData: FormData): Promise<void> {
  const operator = await requireOperatorForAction()
  const slug = String(formData.get('slug') ?? '').trim()
  if (!/^[a-z0-9-]{1,64}$/u.test(slug)) {
    returnToPrompts('error', 'That style preset is invalid.')
  }

  const { error } = await supabaseServer().rpc('promote_prompt_preset', {
    p_slug: slug,
    p_actor: operator.email,
  })
  if (error) {
    returnToPrompts(
      'error',
      error.hint?.trim() || error.message || 'That style preset could not be applied.',
    )
  }

  revalidatePath('/prompts')
  returnToPrompts('preset', slug)
}

export async function promotePromptVersionAction(formData: FormData): Promise<void> {
  const operator = await requireOperatorForAction()
  const promptId = String(formData.get('promptId') ?? '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(promptId)) {
    returnToPrompts('error', 'That prompt version is invalid.')
  }

  const { error } = await supabaseServer().rpc('promote_prompt_version', {
    p_prompt_id: promptId,
    p_actor: operator.email,
  })
  if (error) {
    returnToPrompts(
      'error',
      error.hint?.trim() || error.message || 'The prompt version could not be promoted.',
    )
  }

  revalidatePath('/prompts')
  returnToPrompts('promoted', 'true')
}
