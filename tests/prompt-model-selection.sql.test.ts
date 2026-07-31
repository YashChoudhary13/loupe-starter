import { describe, expect, it } from 'vitest'

import type { PromptKind } from '@/lib/enhance/repository'
import { isCuratedModel } from '@/lib/prompts/models'

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
  // Not pinned to one literal model: D51 exists so an operator can pick any
  // curated option, and D55 makes the pipeline work across all of them. What
  // must stay true regardless of which one is live is that there is exactly
  // one, and it is a model Loupe actually knows how to run — never an
  // arbitrary string that bypassed the RPC's curated-list CHECK constraint.
  it('has exactly one current model on each live prompt, and it is curated', async () => {
    const describePrompt = await livePrompt('describe')
    const imagePrompt = await livePrompt('image')
    expect(isCuratedModel('describe', describePrompt.model)).toBe(true)
    expect(isCuratedModel('image', imagePrompt.model)).toBe(true)
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
