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
 * Deliberately curated choices per stage (eleven describers; nine image models
 * since D120 retired the three weakest editors), ordered from lowest cost to
 * most capable/expensive. This is configuration, not an unbounded provider
 * catalogue.
 *
 * Pricing and availability checked against OpenRouter's official model APIs on
 * 2026-09-03, alongside the September 2026 model research (Roboflow Vision
 * Evals for describers; the Photoroom product-fidelity benchmark and the
 * LMArena / Artificial Analysis editing arenas for image models). Exact
 * provider billing remains authoritative and is shown as a compact hint rather
 * than copied into business logic.
 */
export const DESCRIBE_MODELS: readonly CuratedModel[] = [
  {
    id: 'qwen/qwen3.8-flash',
    label: 'Qwen 3.8 Flash',
    tier: 'Lowest cost',
    priceHint: '$0.15 / $0.47 per 1M tokens',
    note: 'Cheapest usable vision with structured outputs; replaced qwen3.7-flash (22nd/23 on vision evals, no structured outputs).',
  },
  {
    id: 'openai/gpt-5.6-luna-pro',
    label: 'GPT-5.6 Luna Pro',
    tier: 'Lowest cost',
    priceHint: '$0.20 / $1.20 per 1M tokens',
    note: 'Economical OpenAI vision option.',
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    tier: 'Budget',
    priceHint: '$0.30 / $2.50 per 1M tokens',
    note: 'Fastest curated model; strong data extraction. The art-director pick.',
  },
  {
    id: 'google/gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    tier: 'Balanced',
    priceHint: '$0.75 / $3.75 per 1M tokens',
    note: 'Recommended checker: 80.2% counting on Roboflow evals, fastest of the top flashes.',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    tier: 'Balanced',
    priceHint: '$1 / $5 per 1M tokens',
    note: 'Fast and concise, but the family scores poorly on object counting — avoid for counting-critical stages.',
  },
  {
    id: 'google/gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    tier: 'Strong',
    priceHint: '$1.50 / $9 per 1M tokens',
    note: 'Recommended describer: #1 of 36 on Roboflow Vision Evals (86.0% overall, 80.6% counting vs Sol’s 73.0%).',
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
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    tier: 'Strong',
    priceHint: '$3 / $15 per 1M tokens',
    note: 'Strict JSON and strong OCR, but 46% counting (#32/36) — superseded as the production describer.',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    tier: 'Premium',
    priceHint: '$3 / $15 per 1M tokens',
    note: 'Premium instruction following, but 30% on object counting — do not use as describer or checker.',
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    tier: 'Premium',
    priceHint: '$2 / $10 per 1M tokens via OpenRouter',
    note: 'Strong reasoning, but #12/36 on vision evals and beaten on counting by cheaper Gemini flashes.',
  },
] as const

export const IMAGE_MODELS: readonly CuratedModel[] = [
  {
    id: 'black-forest-labs/flux.2-klein-4b',
    label: 'FLUX.2 Klein 4B',
    tier: 'Lowest cost',
    priceHint: 'from $0.014 / megapixel',
    note: 'Very economical experiments only — 16.8% exact-product accuracy on the Photoroom fidelity benchmark.',
  },
  {
    id: 'bytedance-seed/seedream-5-0-lite',
    label: 'Seedream 5.0 Lite',
    tier: 'Budget',
    priceHint: 'from $0.035 / image',
    note: 'Recommended cheap tier for simple pieces; beats Seedream 4.5 on editing while costing less.',
  },
  {
    id: 'black-forest-labs/flux.2-pro',
    label: 'FLUX.2 Pro',
    tier: 'Budget',
    priceHint: 'from $0.03 / megapixel',
    note: 'Low-cost editing, but ranks far below the 2026 editing pack — experiments only.',
  },
  {
    id: 'recraft/recraft-v4.1-utility',
    label: 'Recraft V4.1 Utility',
    tier: 'Budget',
    priceHint: 'from $0.035 / image',
    note: 'Restrained product imagery, but ~1K output only and absent from the editing leaderboards.',
  },
  {
    id: 'bytedance-seed/seedream-5-0-pro',
    label: 'Seedream 5.0 Pro',
    tier: 'Balanced',
    priceHint: '$0.045 standard / $0.09 hi-res per image',
    note: 'Premium within budget: subject preservation, region-aware edits, accepts full 4096px input — best for fine chains.',
  },
  {
    id: 'x-ai/grok-imagine-image-quality',
    label: 'Grok Imagine Quality',
    tier: 'Balanced',
    priceHint: 'about $0.06 / 1K edit',
    note: 'Photorealistic textures and strong arena editing scores, but no product-fidelity evidence yet.',
  },
  {
    id: 'google/gemini-3.1-flash-image',
    label: 'Nano Banana 2',
    tier: 'Strong',
    priceHint: '$0.067 / image at 1K ($0.101 at 2K)',
    note: 'Recommended default: best exact-product accuracy on the Photoroom fidelity benchmark (29.0%), at roughly half the GPT Image 2 spend and ~5x faster.',
  },
  {
    id: 'google/gemini-3-pro-image',
    label: 'Nano Banana Pro',
    tier: 'Premium',
    priceHint: '$0.134 / image at 1K–2K',
    note: 'Best-attested premium editor (28.2% Photoroom); over the render budget except via Batch pricing.',
  },
  {
    id: 'openai/gpt-image-2',
    label: 'GPT Image 2',
    tier: 'Premium',
    priceHint: '$8 / $30 per 1M tokens (≈$0.07–0.09 observed / render)',
    note: 'Long-prompt fallback: top arena editor but mid-pack on real product accuracy (27.2%), with documented artifacting and iterative drift.',
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
