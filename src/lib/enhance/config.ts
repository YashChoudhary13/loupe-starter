export type ImageQuality = 'low' | 'medium' | 'high'
export type DescribeReasoningEffort = 'minimal'

export interface EnhancementConfig {
  readonly describeModel: string
  readonly describeReasoningEffort: DescribeReasoningEffort
  readonly injectDescription: boolean
  readonly imageModel: string
  readonly imageSize: `${number}x${number}`
  readonly imageQuality: ImageQuality
  readonly maxCostUsdPerImage: number
  readonly maxCostUsdPerDescription: number
}

type Environment = Readonly<Record<string, string | undefined>>

function value(env: Environment, key: string, fallback: string): string {
  return env[key]?.trim() || fallback
}

function booleanValue(env: Environment, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${key} must be true or false, got "${raw}".`)
}

function positiveNumber(env: Environment, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  const parsed = raw ? Number(raw) : fallback
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number, got "${raw ?? ''}".`)
  }
  return parsed
}

/**
 * Business configuration uses the friendly OpenAI model names. OpenRouter's
 * wire API requires provider-qualified slugs, and that exact resolved slug is
 * what Loupe persists on every description/version row.
 */
export function resolveOpenRouterModel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) throw new Error('An OpenRouter model name must not be empty.')
  return trimmed.includes('/') ? trimmed : `openai/${trimmed}`
}

export function enhancementConfig(env: Environment = process.env): EnhancementConfig {
  const reasoning = value(env, 'DESCRIBE_REASONING_EFFORT', 'minimal')
  if (reasoning !== 'minimal') {
    throw new Error(
      'DESCRIBE_REASONING_EFFORT must be minimal. Description is a short factual task; extended reasoning is not allowed.',
    )
  }

  const size = value(env, 'IMAGE_SIZE', '1280x1280')
  if (!/^[1-9]\d*x[1-9]\d*$/.test(size)) {
    throw new Error(`IMAGE_SIZE must look like 1280x1280, got "${size}".`)
  }

  const quality = value(env, 'IMAGE_QUALITY', 'medium')
  if (!['low', 'medium', 'high'].includes(quality)) {
    throw new Error(`IMAGE_QUALITY must be low, medium or high, got "${quality}".`)
  }

  return {
    describeModel: resolveOpenRouterModel(value(env, 'DESCRIBE_MODEL', 'gpt-5.6-sol')),
    describeReasoningEffort: reasoning,
    injectDescription: booleanValue(env, 'INJECT_DESCRIPTION', true),
    imageModel: resolveOpenRouterModel(value(env, 'IMAGE_MODEL', 'gpt-image-2')),
    imageSize: size as `${number}x${number}`,
    imageQuality: quality as ImageQuality,
    maxCostUsdPerImage: positiveNumber(env, 'MAX_COST_USD_PER_IMAGE', 0.2),
    maxCostUsdPerDescription: positiveNumber(
      env,
      'MAX_COST_USD_PER_DESCRIPTION',
      0.05,
    ),
  }
}
