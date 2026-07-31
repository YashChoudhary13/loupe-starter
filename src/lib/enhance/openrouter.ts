import type {
  DescribeReasoningEffort,
  ImageQuality,
} from './config'
import { EnhancementError } from './errors'
import {
  parseStructuredDescription,
  type PresentationClass,
  StructuredDescriptionError,
} from './presentation'

export interface DescribeOptions {
  readonly model: string
  readonly reasoningEffort: DescribeReasoningEffort
}

export interface DescriptionResult {
  readonly text: string
  readonly presentation: PresentationClass
  readonly costUsd: number
  readonly model: string
  readonly requestId: string | null
}

export interface EnhanceOptions {
  readonly model: string
  readonly size: `${number}x${number}`
  readonly quality: ImageQuality
}

export interface EnhancementResult {
  readonly image: Buffer
  readonly costUsd: number
  readonly model: string
  readonly generationId: string | null
}

export interface JewelleryDescriber {
  describe(
    input: Buffer,
    mediaType: 'image/jpeg' | 'image/png',
    prompt: string,
    options: DescribeOptions,
  ): Promise<DescriptionResult>
}

export interface ImageEnhancer {
  enhance(
    input: Buffer,
    mediaType: 'image/jpeg' | 'image/png',
    prompt: string,
    options: EnhanceOptions,
  ): Promise<EnhancementResult>
}

interface OpenRouterUsage {
  cost?: number | string
}

interface ChatResponse {
  id?: string
  model?: string
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
  usage?: OpenRouterUsage
}

interface ImageResponse {
  id?: string
  model?: string
  data?: Array<{
    b64_json?: string
    url?: string
  }>
  usage?: OpenRouterUsage
}

interface OpenRouterErrorBody {
  error?: {
    code?: string | number
    message?: string
    metadata?: unknown
  }
  error_type?: string
}

function dataUrl(input: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${input.toString('base64')}`
}

/**
 * Provider families OpenRouter documents as normalising the unified `reasoning`
 * parameter (effort/exclude) onto their own native control — OpenAI, Anthropic,
 * Google Gemini "thinking" models and Qwen. Every curated describe model
 * (src/lib/prompts/models.ts) falls into one of these four (D51). Restricting
 * this to `openai/` alone left every other curated model spending its whole
 * completion budget on unsuppressed reasoning before emitting any JSON — caught
 * live against `google/gemini-3.1-pro-preview` (docs/PROGRESS.md, 2026-07-31).
 * See D55.
 */
const REASONING_CAPABLE_PREFIXES = ['openai/', 'google/', 'anthropic/', 'qwen/']

function supportsReasoningControl(model: string): boolean {
  return REASONING_CAPABLE_PREFIXES.some((prefix) => model.startsWith(prefix))
}

function imageGenerationParameters(options: EnhanceOptions): Record<string, unknown> {
  if (options.model.startsWith('openai/')) {
    return { size: options.size, quality: options.quality }
  }

  // OpenRouter's dedicated Images API exposes a shared aspect-ratio contract
  // across the curated non-OpenAI edit models. Their native pixel dimensions
  // differ, so the worker normalises a square result to Loupe's configured size.
  return { aspect_ratio: '1:1' }
}

function costOf(usage: OpenRouterUsage | undefined, stage: 'describe' | 'image'): number {
  const cost = typeof usage?.cost === 'string' ? Number(usage.cost) : usage?.cost
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw new EnhancementError(
      `OpenRouter returned no valid usage.cost for the ${stage} call.`,
      {
        stage,
        code: `${stage}_cost_missing`,
        retryable: stage === 'describe',
        detail: usage,
      },
    )
  }
  return cost
}

function responseText(response: ChatResponse): string | null {
  const content = response.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim() ? content : null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  return text.trim() ? text : null
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function openRouterFailure(
  stage: 'describe' | 'image',
  response: Response,
  body: unknown,
): EnhancementError {
  const parsed = body as OpenRouterErrorBody | null
  const type = parsed?.error_type
  const providerCode = parsed?.error?.code
  const codeText = String(type ?? providerCode ?? '')
  const retryable =
    stage === 'describe' ||
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  const policy = /content_policy|moderation|safety|refusal/i.test(codeText)

  return new EnhancementError(
    stage === 'describe'
      ? 'The jewellery description could not be generated.'
      : policy
        ? 'The image model refused this photograph under its content policy.'
        : response.status === 429
          ? 'The image model is rate-limited; Loupe will retry it.'
          : response.status >= 500
            ? 'The image model is temporarily unavailable; Loupe will retry it.'
            : 'The image model rejected this photograph.',
    {
      stage,
      code:
        stage === 'describe'
          ? 'description_provider_failed'
          : policy
            ? 'image_content_policy'
            : response.status === 429
              ? 'image_rate_limited'
              : response.status >= 500
                ? 'image_provider_unavailable'
                : 'image_request_rejected',
      retryable,
      detail: {
        status: response.status,
        error_type: type,
        provider_code: providerCode,
        body,
      },
    },
  )
}

export class OpenRouterClient implements JewelleryDescriber, ImageEnhancer {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://openrouter.ai/api/v1',
  ) {
    if (!apiKey.trim()) throw new Error('OPENROUTER_API_KEY is missing.')
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://qimati-loupe.vercel.app',
      'X-Title': 'Qimati Loupe',
    }
  }

  async describe(
    input: Buffer,
    mediaType: 'image/jpeg' | 'image/png',
    prompt: string,
    options: DescribeOptions,
  ): Promise<DescriptionResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl(input, mediaType) } },
              ],
            },
          ],
          ...(supportsReasoningControl(options.model)
            ? {
                reasoning: {
                  effort: options.reasoningEffort,
                  exclude: true,
                },
              }
            : {}),
          // 60-100 words of JSON content needs well under this even with the
          // fence/preamble some non-OpenAI models add; the margin exists so a
          // model's own suppressed-reasoning tokens (still billed even with
          // exclude:true) don't crowd out the actual answer. Cost stays bounded
          // by MAX_COST_USD_PER_DESCRIPTION regardless of this ceiling.
          max_completion_tokens: 512,
          stream: false,
        }),
      })
    } catch (error) {
      throw new EnhancementError('The jewellery description service could not be reached.', {
        stage: 'describe',
        code: 'description_network_error',
        retryable: true,
        detail: error,
      })
    }

    const body = await bodyOf(response)
    if (!response.ok) throw openRouterFailure('describe', response, body)

    const parsed = body as ChatResponse
    const rawResult = responseText(parsed)
    if (!rawResult) {
      throw new EnhancementError(
        'The jewellery describer returned no structured result.',
        {
          stage: 'describe',
          code: 'description_empty_result',
          retryable: true,
          detail: {
            request_id: parsed.id,
            parse_reason: 'empty_result',
            raw_result: rawResult,
          },
        },
      )
    }

    let structured
    try {
      structured = parseStructuredDescription(rawResult)
    } catch (error) {
      if (!(error instanceof StructuredDescriptionError)) throw error
      throw new EnhancementError(
        'The jewellery describer returned malformed structured output.',
        {
          stage: 'describe',
          code: `description_${error.reason}`,
          retryable: true,
          detail: {
            request_id: parsed.id,
            parse_reason: error.reason,
            raw_result: error.rawResult.slice(0, 16_000),
          },
        },
      )
    }

    return {
      text: structured.description,
      presentation: structured.presentation,
      costUsd: costOf(parsed.usage, 'describe'),
      model: parsed.model?.trim() || options.model,
      requestId: parsed.id?.trim() || null,
    }
  }

  async enhance(
    input: Buffer,
    mediaType: 'image/jpeg' | 'image/png',
    prompt: string,
    options: EnhanceOptions,
  ): Promise<EnhancementResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/images`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.timeout(270_000),
        body: JSON.stringify({
          model: options.model,
          prompt,
          input_references: [
            {
              type: 'image_url',
              image_url: { url: dataUrl(input, mediaType) },
            },
          ],
          ...imageGenerationParameters(options),
          n: 1,
        }),
      })
    } catch (error) {
      throw new EnhancementError('The image model could not be reached.', {
        stage: 'image',
        code: 'image_network_error',
        retryable: true,
        detail: error,
      })
    }

    const body = await bodyOf(response)
    if (!response.ok) throw openRouterFailure('image', response, body)

    const parsed = body as ImageResponse
    const item = parsed.data?.[0]
    let image: Buffer
    if (item?.b64_json) {
      image = Buffer.from(item.b64_json, 'base64')
    } else if (item?.url) {
      let imageResponse: Response
      try {
        imageResponse = await this.fetchImpl(item.url, {
          signal: AbortSignal.timeout(60_000),
        })
      } catch (error) {
        throw new EnhancementError('The image model returned an image URL that could not be read.', {
          stage: 'image',
          code: 'image_download_failed',
          retryable: true,
          detail: error,
        })
      }
      if (!imageResponse.ok) {
        throw new EnhancementError('The image model returned an image URL that could not be read.', {
          stage: 'image',
          code: 'image_download_failed',
          retryable: imageResponse.status === 429 || imageResponse.status >= 500,
          detail: { status: imageResponse.status },
        })
      }
      image = Buffer.from(await imageResponse.arrayBuffer())
    } else {
      throw new EnhancementError('The image model returned no image.', {
        stage: 'image',
        code: 'image_missing',
        retryable: false,
        detail: body,
      })
    }

    if (image.byteLength === 0) {
      throw new EnhancementError('The image model returned an empty image.', {
        stage: 'image',
        code: 'image_empty',
        retryable: false,
      })
    }

    return {
      image,
      costUsd: costOf(parsed.usage, 'image'),
      model: parsed.model?.trim() || options.model,
      generationId: parsed.id?.trim() || null,
    }
  }
}
