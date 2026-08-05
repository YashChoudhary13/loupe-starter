import { describe, expect, it } from 'vitest'

import {
  enhancementConfig,
  resolveOpenRouterModel,
} from '@/lib/enhance/config'
import {
  PRODUCT_DESCRIPTION_TOKEN,
  resolveImagePrompt,
} from '@/lib/enhance/prompt'

import { TEST_DESCRIPTION, TEST_PROMPTS } from './helpers/enhancement'

describe('Phase 3B two-call configuration', () => {
  it('uses the amendment defaults and resolves friendly model names for OpenRouter', () => {
    const config = enhancementConfig({})
    expect(config).toEqual({
      describeModel: 'openai/gpt-5.6-sol',
      describeReasoningEffort: 'minimal',
      injectDescription: true,
      imageModel: 'openai/gpt-image-2',
      imageSize: '1280x1280',
      imageQuality: 'medium',
      maxCostUsdPerImage: 0.2,
      maxCostUsdPerDescription: 0.05,
    })
    expect(resolveOpenRouterModel('anthropic/example')).toBe('anthropic/example')
  })

  it('refuses extended description reasoning', () => {
    expect(() =>
      enhancementConfig({ DESCRIBE_REASONING_EFFORT: 'low' }),
    ).toThrow(/must be minimal/)
  })

  it('injects by one literal replacement and stores the resolved text', () => {
    const resolved = resolveImagePrompt(
      TEST_PROMPTS.image.body,
      TEST_DESCRIPTION,
      true,
      false,
      'pair-upright',
    )
    expect(resolved.descriptionInjected).toBe(true)
    expect(resolved.descriptionMissing).toBe(false)
    expect(resolved.text).toContain(`PRODUCT\n${TEST_DESCRIPTION}\n\nCOMPOSITION`)
    expect(resolved.text).toContain('Show the exact source pieces upright and face-readable')
    expect(resolved.text).not.toContain(PRODUCT_DESCRIPTION_TOKEN)
    expect(resolved.text).not.toContain('{{COMPOSITION_DETAIL}}')
  })

  it('removes the entire PRODUCT block when injection is disabled', () => {
    const resolved = resolveImagePrompt(
      TEST_PROMPTS.image.body,
      TEST_DESCRIPTION,
      false,
      false,
      'flat-curve',
    )
    expect(resolved.descriptionInjected).toBe(false)
    expect(resolved.descriptionMissing).toBe(false)
    expect(resolved.text).toContain(
      'This is the legacy fallback for a flexible necklace or long chain',
    )
    expect(resolved.text).not.toMatch(/^PRODUCT\s*$/m)
    expect(resolved.text).not.toContain(PRODUCT_DESCRIPTION_TOKEN)
  })

  it('records missing description separately from a deliberate A/B exclusion', () => {
    const resolved = resolveImagePrompt(
      TEST_PROMPTS.image.body,
      null,
      true,
      true,
      'flat-curve',
    )
    expect(resolved.descriptionInjected).toBe(false)
    expect(resolved.descriptionMissing).toBe(true)
    expect(resolved.text).toContain(
      'This is the legacy fallback for a flexible necklace or long chain',
    )
  })
})
