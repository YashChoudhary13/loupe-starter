import type { PromptKind } from '@/lib/enhance/repository'

export interface CuratedModel {
  readonly id: string
  readonly label: string
  /** Short, deliberately non-numeric tier: provider prices can change. */
  readonly tier: 'Lowest cost' | 'Budget' | 'Balanced' | 'Strong' | 'Premium'
  readonly priceHint: string
  readonly note: string
}

/**
 * Ten deliberately curated choices per stage, ordered from lowest cost to most
 * capable/expensive. This is configuration, not an unbounded provider catalogue.
 *
 * Pricing and availability checked against OpenRouter's official model APIs on
 * 2026-07-30. Exact provider billing remains authoritative and is shown as a
 * compact hint rather than copied into business logic.
 */
export const DESCRIBE_MODELS: readonly CuratedModel[] = [
  {
    id: 'qwen/qwen3.7-flash',
    label: 'Qwen 3.7 Flash',
    tier: 'Lowest cost',
    priceHint: '$0.03 / $0.13 per 1M tokens',
    note: 'Fastest low-cost factual option.',
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    tier: 'Budget',
    priceHint: '$0.30 / $2.50 per 1M tokens',
    note: 'Low-cost vision with good instruction following.',
  },
  {
    id: 'openai/gpt-5.6-luna-pro',
    label: 'GPT-5.6 Luna Pro',
    tier: 'Budget',
    priceHint: '$0.50 / $3 per 1M tokens',
    note: 'Economical OpenAI vision option.',
  },
  {
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    tier: 'Balanced',
    priceHint: '$0.75 / $4.50 per 1M tokens',
    note: 'Good cost/accuracy balance.',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    tier: 'Balanced',
    priceHint: '$1 / $5 per 1M tokens',
    note: 'Fast visual analysis and concise output.',
  },
  {
    id: 'google/gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    tier: 'Balanced',
    priceHint: '$1.50 / $7.50 per 1M tokens',
    note: 'Stronger multimodal detail at moderate cost.',
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    tier: 'Strong',
    priceHint: '$2 / $12 per 1M tokens',
    note: 'High-detail visual reasoning.',
  },
  {
    id: 'openai/gpt-5.4',
    label: 'GPT-5.4',
    tier: 'Strong',
    priceHint: '$2.50 / $15 per 1M tokens',
    note: 'Strong structured-output reliability.',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    tier: 'Premium',
    priceHint: '$3 / $15 per 1M tokens',
    note: 'Premium vision and instruction following.',
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    tier: 'Premium',
    priceHint: '$5 / $30 per 1M tokens',
    note: 'Current Qimati default; already acceptance-tested.',
  },
] as const

export const IMAGE_MODELS: readonly CuratedModel[] = [
  {
    id: 'black-forest-labs/flux.2-klein-4b',
    label: 'FLUX.2 Klein 4B',
    tier: 'Lowest cost',
    priceHint: 'from $0.014 / megapixel',
    note: 'Very economical edits and experiments.',
  },
  {
    id: 'black-forest-labs/flux.2-pro',
    label: 'FLUX.2 Pro',
    tier: 'Budget',
    priceHint: 'from $0.03 / megapixel',
    note: 'Low-cost production-grade image editing.',
  },
  {
    id: 'recraft/recraft-v4.1-utility',
    label: 'Recraft V4.1 Utility',
    tier: 'Budget',
    priceHint: 'from $0.035 / image',
    note: 'Restrained product imagery rather than stylisation.',
  },
  {
    id: 'bytedance-seed/seedream-4.5',
    label: 'Seedream 4.5',
    tier: 'Budget',
    priceHint: 'from $0.04 / image',
    note: 'Strong subject-detail and colour preservation.',
  },
  {
    id: 'openai/gpt-image-1-mini',
    label: 'GPT Image 1 Mini',
    tier: 'Balanced',
    priceHint: 'low-cost OpenAI image tokens',
    note: 'Economical image editing with reference support.',
  },
  {
    id: 'x-ai/grok-imagine-image-quality',
    label: 'Grok Imagine Quality',
    tier: 'Balanced',
    priceHint: 'about $0.06 / 1K edit',
    note: 'Photorealistic textures and product placement.',
  },
  {
    id: 'black-forest-labs/flux.2-max',
    label: 'FLUX.2 Max',
    tier: 'Strong',
    priceHint: 'from $0.07 / megapixel',
    note: 'Higher-fidelity FLUX editing.',
  },
  {
    id: 'google/gemini-3.1-flash-image',
    label: 'Nano Banana 2',
    tier: 'Strong',
    priceHint: 'provider-priced image tokens',
    note: 'Fast, capable multi-image editing.',
  },
  {
    id: 'google/gemini-3-pro-image',
    label: 'Nano Banana Pro',
    tier: 'Premium',
    priceHint: 'premium image tokens',
    note: 'Google’s highest-quality image editing option.',
  },
  {
    id: 'openai/gpt-image-2',
    label: 'GPT Image 2',
    tier: 'Premium',
    priceHint: 'premium OpenAI image tokens',
    note: 'Current Qimati default; already acceptance-tested.',
  },
] as const

export function modelsFor(kind: PromptKind): readonly CuratedModel[] {
  return kind === 'describe' ? DESCRIBE_MODELS : IMAGE_MODELS
}

export function isCuratedModel(kind: PromptKind, model: string): boolean {
  return modelsFor(kind).some((option) => option.id === model)
}

export function curatedModel(kind: PromptKind, model: string): CuratedModel | null {
  return modelsFor(kind).find((option) => option.id === model) ?? null
}
