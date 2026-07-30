/**
 * Isolated Phase 3C description-model cost evaluation.
 *
 * This makes paid description calls against preserved local acceptance sources.
 * It never writes production state and never changes DESCRIBE_MODEL.
 *
 * PHASE3C_DESCRIPTION_EVAL=I_UNDERSTAND_THIS_MAKES_PAID_CALLS \
 * NODE_OPTIONS=--conditions=react-server npx tsx scripts/evaluate-description-models.ts
 */
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

import { config as loadEnv } from 'dotenv'

import type { PresentationClass } from '../src/lib/enhance/presentation'

loadEnv({ path: '.env', quiet: true })
loadEnv({ path: '.env.local', override: true, quiet: true })

const CONFIRMATION = 'I_UNDERSTAND_THIS_MAKES_PAID_CALLS'
const COST_TARGET_USD = 0.006
const DEFAULT_CANDIDATES = [
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'google/gemini-3.1-flash-lite-preview',
] as const
const SOURCES = [
  {
    filename: 'phase3b-01.png',
    expectedPresentation: 'flat-curve',
  },
  {
    filename: 'phase3b-02.jpg',
    expectedPresentation: 'flat-arc',
  },
  {
    filename: 'phase3b-03.jpg',
    expectedPresentation: 'flat-arc',
  },
  {
    filename: 'phase3b-04.png',
    expectedPresentation: 'tray-grid',
  },
  {
    filename: 'user-earrings-source.png',
    expectedPresentation: 'pair-upright',
  },
] as const satisfies readonly {
  filename: string
  expectedPresentation: PresentationClass
}[]

interface WireCapture {
  request?: {
    model: string
    reasoning: unknown
    maxCompletionTokens: unknown
    stream: unknown
    prompt: unknown
    imageReference: {
      type: unknown
      mediaType: string | null
      sha256: string
    }
  }
  responseStatus?: number
  responseBody?: unknown
}

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env`)
  return value
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function dataUrlBytes(value: unknown): Buffer {
  invariant(typeof value === 'string', 'The describe request image URL is missing.')
  const match = value.match(/^data:[^;]+;base64,(.+)$/u)
  invariant(match?.[1], 'The describe request image URL is not a typed data URL.')
  return Buffer.from(match[1], 'base64')
}

function responseContent(body: unknown): string | null {
  const content = (
    body as {
      choices?: {
        message?: {
          content?: unknown
        }
      }[]
    } | null
  )?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('')
}

function providerReportedCost(body: unknown): number | null {
  const raw = (
    body as {
      usage?: {
        cost?: unknown
      }
    } | null
  )?.usage?.cost
  const cost = typeof raw === 'string' ? Number(raw) : raw
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? cost
    : null
}

function safeError(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error)
  return {
    name: error.name,
    message: error.message,
    ...(Object.hasOwn(error, 'code')
      ? { code: (error as Error & { code?: unknown }).code }
      : {}),
    ...(Object.hasOwn(error, 'detail')
      ? { detail: (error as Error & { detail?: unknown }).detail }
      : {}),
  }
}

async function main(): Promise<void> {
  invariant(
    process.env.PHASE3C_DESCRIPTION_EVAL === CONFIRMATION,
    `Refusing paid calls. Set PHASE3C_DESCRIPTION_EVAL=${CONFIRMATION}.`,
  )

  const [
    { enhancementConfig },
    { prepareModelInput },
    { OpenRouterClient },
    { pgClient },
  ] = await Promise.all([
    import('../src/lib/enhance/config'),
    import('../src/lib/enhance/image'),
    import('../src/lib/enhance/openrouter'),
    import('./lib/pg'),
  ])
  const productionDescribeModel = enhancementConfig().describeModel
  const candidates = (
    process.env.PHASE3C_DESCRIPTION_CANDIDATES?.split(',') ??
    [...DEFAULT_CANDIDATES]
  )
    .map((candidate) => candidate.trim())
    .filter(Boolean)
  invariant(candidates.length > 0, 'At least one description candidate is required.')
  invariant(
    !candidates.includes(productionDescribeModel),
    'The isolated evaluation must not repeat the current production model.',
  )

  const db = pgClient()
  await db.connect()
  let describePrompt: string
  try {
    const prompt = await db.query<{ body: string }>(
      `select body
         from public.prompts
        where name = 'Qimati factual describer — bounded presentation'
          and is_default
          and archived_at is null`,
    )
    invariant(prompt.rows.length === 1, 'The live Phase 3C describe prompt is missing.')
    describePrompt = prompt.rows[0]!.body
  } finally {
    await db.end()
  }

  const modelCatalogResponse = await fetch('https://openrouter.ai/api/v1/models')
  invariant(modelCatalogResponse.ok, 'OpenRouter model metadata could not be read.')
  const modelCatalog = (await modelCatalogResponse.json()) as {
    data?: {
      id?: string
      name?: string
      architecture?: {
        input_modalities?: string[]
        output_modalities?: string[]
      }
      pricing?: Record<string, string>
      supported_parameters?: string[]
    }[]
  }
  const candidateMetadata = candidates.map((candidate) => {
    const metadata = modelCatalog.data?.find((model) => model.id === candidate)
    invariant(metadata, `OpenRouter no longer lists candidate ${candidate}.`)
    invariant(
      metadata.architecture?.input_modalities?.includes('image') &&
        metadata.architecture.output_modalities?.includes('text'),
      `${candidate} does not advertise image input and text output.`,
    )
    return metadata
  })

  const sourceRoot = resolve('.artifacts/phase3c-acceptance/source')
  const preparedSources = await Promise.all(
    SOURCES.map(async (source) => {
      const original = readFileSync(resolve(sourceRoot, source.filename))
      const prepared = await prepareModelInput(original)
      return {
        ...source,
        originalSha256: sha256(original),
        prepared,
      }
    }),
  )
  const apiKey = required('OPENROUTER_API_KEY')
  const results = []

  for (const candidate of candidates) {
    const candidateResults = []
    for (const source of preparedSources) {
      const wire: WireCapture = {}
      const recordingFetch: typeof fetch = async (input, init) => {
        const requestBody = JSON.parse(String(init?.body)) as {
          model: string
          messages?: {
            content?: {
              type?: unknown
              text?: unknown
              image_url?: { url?: unknown }
            }[]
          }[]
          reasoning?: unknown
          max_completion_tokens?: unknown
          stream?: unknown
        }
        const content = requestBody.messages?.[0]?.content ?? []
        const textPart = content.find((part) => part.type === 'text')
        const imagePart = content.find((part) => part.type === 'image_url')
        const imageBytes = dataUrlBytes(imagePart?.image_url?.url)
        const dataUrl = imagePart?.image_url?.url
        wire.request = {
          model: requestBody.model,
          reasoning: requestBody.reasoning,
          maxCompletionTokens: requestBody.max_completion_tokens,
          stream: requestBody.stream,
          prompt: textPart?.text,
          imageReference: {
            type: imagePart?.type,
            mediaType:
              typeof dataUrl === 'string'
                ? dataUrl.match(/^data:([^;]+);base64,/u)?.[1] ?? null
                : null,
            sha256: sha256(imageBytes),
          },
        }
        const response = await fetch(input, init)
        wire.responseStatus = response.status
        const responseText = await response.clone().text()
        try {
          wire.responseBody = JSON.parse(responseText) as unknown
        } catch {
          wire.responseBody = responseText
        }
        return response
      }
      const client = new OpenRouterClient(apiKey, recordingFetch)
      try {
        const response = await client.describe(
          source.prepared.buffer,
          source.prepared.mediaType,
          describePrompt,
          {
            model: candidate,
            reasoningEffort: 'minimal',
          },
        )
        candidateResults.push({
          filename: source.filename,
          originalSha256: source.originalSha256,
          preparedSha256: sha256(source.prepared.buffer),
          expectedPresentation: source.expectedPresentation,
          strictValidJson: true,
          description: response.text,
          descriptionWordCount: response.text.split(/\s+/u).filter(Boolean).length,
          presentation: response.presentation,
          presentationMatchesBaseline:
            response.presentation === source.expectedPresentation,
          providerReportedCostUsd: response.costUsd,
          costBelowTarget: response.costUsd < COST_TARGET_USD,
          responseModel: response.model,
          requestId: response.requestId,
          rawStructuredOutput: responseContent(wire.responseBody),
          wire,
        })
      } catch (error) {
        const costUsd = providerReportedCost(wire.responseBody)
        candidateResults.push({
          filename: source.filename,
          originalSha256: source.originalSha256,
          preparedSha256: sha256(source.prepared.buffer),
          expectedPresentation: source.expectedPresentation,
          strictValidJson: false,
          providerReportedCostUsd: costUsd,
          costBelowTarget:
            costUsd !== null && costUsd < COST_TARGET_USD,
          error: safeError(error),
          rawStructuredOutput: responseContent(wire.responseBody),
          wire,
        })
      }
      const latest = candidateResults.at(-1)!
      console.log(
        JSON.stringify({
          candidate,
          filename: source.filename,
          strictValidJson: latest.strictValidJson,
          presentation:
            'presentation' in latest ? latest.presentation : null,
          costUsd:
            'providerReportedCostUsd' in latest
              ? latest.providerReportedCostUsd
              : null,
        }),
      )
    }
    results.push({
      candidate,
      results: candidateResults,
      strictJsonPass:
        candidateResults.every((result) => result.strictValidJson),
      presentationPass: candidateResults.every(
        (result) =>
          'presentationMatchesBaseline' in result &&
          result.presentationMatchesBaseline,
      ),
      costPass: candidateResults.every(
        (result) => 'costBelowTarget' in result && result.costBelowTarget,
      ),
      factualDescriptionReview: 'pending_manual_review',
      imageFidelityAndTrayCountGate:
        'not_run_requires_explicit_candidate_decision_and_fresh_five-product_image_acceptance',
      productionEligible: false,
    })
  }

  invariant(
    enhancementConfig().describeModel === productionDescribeModel,
    'The evaluation changed the production description model in-process.',
  )
  const evidence = {
    generatedAt: new Date().toISOString(),
    isolated: true,
    productionWrites: 0,
    productionDescribeModelBefore: productionDescribeModel,
    productionDescribeModelAfter: enhancementConfig().describeModel,
    costTargetUsd: COST_TARGET_USD,
    describePrompt,
    candidateMetadata,
    results,
    decisionGate:
      'No candidate can replace production until factual review passes, the user explicitly selects it, configuration and evidence are updated, and a fresh comparable five-product image acceptance confirms fidelity and the 87-item tray count.',
  }
  const evidenceRoot = resolve('.artifacts/phase3c-description-eval')
  mkdirSync(evidenceRoot, { recursive: true })
  const evidencePath = resolve(evidenceRoot, 'evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(
    JSON.stringify(
      {
        evidence: evidencePath,
        productionDescribeModel,
        candidates: results.map((candidate) => ({
          candidate: candidate.candidate,
          strictJsonPass: candidate.strictJsonPass,
          presentationPass: candidate.presentationPass,
          costPass: candidate.costPass,
          totalCostUsd: candidate.results.reduce(
            (sum, result) =>
              sum +
              (typeof result.providerReportedCostUsd === 'number'
                ? result.providerReportedCostUsd
                : 0),
            0,
          ),
        })),
      },
      null,
      2,
    ),
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
