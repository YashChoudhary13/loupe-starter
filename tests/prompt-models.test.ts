import { describe, expect, it } from 'vitest'

import {
  DESCRIBE_MODELS,
  IMAGE_MODELS,
  isCuratedModel,
  modelsFor,
} from '@/lib/prompts/models'

describe('curated enhancement models', () => {
  it('offers exactly the deliberate curated choices for each prompt stage', () => {
    // Eleven describers and nine image models since D120 refreshed the lists
    // from the September 2026 research (dropped qwen3.7-flash, gpt-5.4-mini,
    // gpt-image-1-mini, seedream-4.5 and flux.2-max; added qwen3.8-flash,
    // gemini-3.5-flash and the Seedream 5.0 pair).
    expect(DESCRIBE_MODELS).toHaveLength(11)
    expect(IMAGE_MODELS).toHaveLength(9)
    expect(new Set(DESCRIBE_MODELS.map((model) => model.id))).toHaveLength(11)
    expect(new Set(IMAGE_MODELS.map((model) => model.id))).toHaveLength(9)
    // Previously accepted production models stay selectable so stored prompt
    // rows keep resolving.
    expect(DESCRIBE_MODELS.some((model) => model.id === 'moonshotai/kimi-k3')).toBe(true)
    expect(IMAGE_MODELS.some((model) => model.id === 'openai/gpt-image-2')).toBe(true)
  })

  it('offers the D120 recommended defaults for the matrix pairs', () => {
    expect(DESCRIBE_MODELS.some((model) => model.id === 'google/gemini-3.5-flash')).toBe(true)
    expect(IMAGE_MODELS.some((model) => model.id === 'google/gemini-3.1-flash-image')).toBe(true)
    expect(IMAGE_MODELS.at(-1)?.id).toBe('openai/gpt-image-2')
  })

  it('never accepts a model from the wrong stage or outside the curated list', () => {
    expect(isCuratedModel('describe', 'openai/gpt-5.6-sol')).toBe(true)
    expect(isCuratedModel('describe', 'openai/gpt-image-2')).toBe(false)
    expect(isCuratedModel('image', 'openai/gpt-image-2')).toBe(true)
    expect(isCuratedModel('image', 'some-provider/every-model')).toBe(false)
    expect(modelsFor('describe')).toBe(DESCRIBE_MODELS)
    expect(modelsFor('image')).toBe(IMAGE_MODELS)
  })
})
