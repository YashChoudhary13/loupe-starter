export type ImageQuality = 'low' | 'medium' | 'high'

/**
 * Describe-stage reasoning effort.
 *
 * This was locked to `minimal` purely to stop reasoning spend on
 * `openai/gpt-5.6-sol` at $5/$30 per 1M tokens, where a heavy call reached
 * $0.053134 and was rejected by the cost ceiling. On `moonshotai/kimi-k3`
 * ($3/$15) a full description measured $0.0108–$0.0217, so effort is now a
 * tunable rather than a hard block — `MAX_COST_USD_PER_DESCRIPTION` remains the
 * real guard, and it fails safe by refusing the result rather than overspending.
 *
 * Default stays `minimal`: raising it is a deliberate, measurable experiment,
 * not something that should change under anyone by upgrading.
 */
export type DescribeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

const DESCRIBE_REASONING_EFFORTS: readonly DescribeReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
]

export interface EnhancementConfig {
  readonly describeModel: string
  readonly describeReasoningEffort: DescribeReasoningEffort
  readonly injectDescription: boolean
  readonly imageModel: string
  readonly imageSize: `${number}x${number}`
  readonly imageQuality: ImageQuality
  readonly maxCostUsdPerImage: number
  readonly maxCostUsdPerDescription: number
  /**
   * D120 — the render checker. When enabled, every fresh generation is
   * verified against its source photograph; a failed verdict earns bounded
   * regeneration with targeted correction lines. The checker is fail-open:
   * its own errors are recorded and the render accepted unchecked.
   */
  readonly checkEnabled: boolean
  readonly checkModel: string
  readonly maxCostUsdPerCheck: number
  /** Total renders allowed per photograph including the first (1 disables retry). */
  readonly maxRenderAttempts: number
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
  if (!DESCRIBE_REASONING_EFFORTS.includes(reasoning as DescribeReasoningEffort)) {
    throw new Error(
      `DESCRIBE_REASONING_EFFORT must be one of ${DESCRIBE_REASONING_EFFORTS.join(', ')}, got "${reasoning}".`,
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
    describeModel: resolveOpenRouterModel(value(env, 'DESCRIBE_MODEL', 'moonshotai/kimi-k3')),
    describeReasoningEffort: reasoning as DescribeReasoningEffort,
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
    checkEnabled: booleanValue(env, 'CHECK_ENABLED', true),
    checkModel: resolveOpenRouterModel(value(env, 'CHECK_MODEL', 'google/gemini-3.6-flash')),
    maxCostUsdPerCheck: positiveNumber(env, 'MAX_COST_USD_PER_CHECK', 0.02),
    maxRenderAttempts: renderAttempts(env),
  }
}

/**
 * Bounded 1..3: 1 disables retry entirely, 3 is already double the researched
 * budget. Anything outside that band is a typo, not an intention.
 */
function renderAttempts(env: Environment): number {
  const raw = env['MAX_RENDER_ATTEMPTS']?.trim()
  const parsed = raw ? Number(raw) : 2
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error(`MAX_RENDER_ATTEMPTS must be an integer from 1 to 3, got "${raw ?? ''}".`)
  }
  return parsed
}
