import { describe, expect, it } from 'vitest'

import {
  DESCRIBE_MODELS,
  IMAGE_MODELS,
  isCuratedModel,
  modelsFor,
} from '@/lib/prompts/models'

describe('curated enhancement models', () => {
  it('offers exactly ten deliberate choices for each prompt stage', () => {
    expect(DESCRIBE_MODELS).toHaveLength(10)
    expect(IMAGE_MODELS).toHaveLength(10)
    expect(new Set(DESCRIBE_MODELS.map((model) => model.id))).toHaveLength(10)
    expect(new Set(IMAGE_MODELS.map((model) => model.id))).toHaveLength(10)
  })

  it('keeps the already accepted models as the premium defaults in the lists', () => {
    expect(DESCRIBE_MODELS.at(-1)?.id).toBe('openai/gpt-5.6-sol')
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
