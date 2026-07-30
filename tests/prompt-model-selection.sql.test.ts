import { describe, expect, it } from 'vitest'

import type { PromptKind } from '@/lib/enhance/repository'

import { serviceClient } from './helpers/db'

const db = serviceClient()

async function livePrompt(kind: PromptKind) {
  const { data, error } = await db
    .from('prompts')
    .select('id, kind, model, is_default, archived_at')
    .eq('kind', kind)
    .eq('is_default', true)
    .is('archived_at', null)
    .single<{ id: string; kind: PromptKind; model: string; is_default: boolean; archived_at: null }>()
  if (error || !data) throw new Error(error?.message ?? `no live ${kind} prompt`)
  return data
}

describe('deployed prompt model selection', () => {
  it('has one current model on each live prompt', async () => {
    expect((await livePrompt('describe')).model).toBe('openai/gpt-5.6-sol')
    expect((await livePrompt('image')).model).toBe('openai/gpt-image-2')
  })

  it('selecting the current model is an idempotent no-op', async () => {
    const before = await livePrompt('describe')
    const { data, error } = await db.rpc('select_prompt_model', {
      p_kind: 'describe',
      p_model: before.model,
      p_actor: 'test:prompt-model-selection',
    })
    expect(error).toBeNull()
    expect(data).toBe(before.id)
    expect(await livePrompt('describe')).toEqual(before)
  })

  it('rejects a model from the wrong stage and rolls the default switch back', async () => {
    const before = await livePrompt('describe')
    const { error } = await db.rpc('select_prompt_model', {
      p_kind: 'describe',
      p_model: 'openai/gpt-image-2',
      p_actor: 'test:prompt-model-selection',
    })
    expect(error?.code).toBe('23514')
    expect(await livePrompt('describe')).toEqual(before)
  })
})
