import { createHash } from 'node:crypto'

import type { DriveDownloader } from '@/lib/google/drive-types'
import { perceptualHash } from '@/lib/duplicates/phash'

import type { EnhancementConfig } from './config'
import {
  classifyWorkerError,
  EnhancementError,
  safeErrorDetail,
} from './errors'
import {
  makeThumbnail,
  normaliseGeneratedImage,
  prepareModelInput,
  readImageDimensions,
} from './image'
import type {
  DescriptionResult,
  ImageEnhancer,
  JewelleryDescriber,
} from './openrouter'
import { resolveImagePrompt } from './prompt'
import type { PresentationClass } from './presentation'
import {
  type EnhancementClaim,
  type EnhancementRepository,
  EnhancementRepositoryError,
} from './repository'
import {
  type ImmutableObjectStore,
  sha256,
  type StoredObject,
} from './storage'

const SOURCE = 'enhancement-worker'
const LEASE_SECONDS = 900
const MAX_BATCH_SIZE = 2
const DEFAULT_TIME_BUDGET_MS = 240_000

export type EnhancementOutcomeStatus =
  | 'enhanced'
  | 'retry_scheduled'
  | 'failed'
  | 'cost_ceiling_failed'

export interface EnhancementOutcome {
  readonly intakeFileId: string
  readonly status: EnhancementOutcomeStatus
  readonly attempts: number
  readonly imageVersionId?: string
  readonly costUsd?: number
  readonly descriptionCalled: boolean
  readonly descriptionInjected: boolean
  readonly descriptionMissing: boolean
}

export interface EnhancementBatchResult {
  readonly claimed: number
  readonly enhanced: number
  readonly retryScheduled: number
  readonly failed: number
  readonly costCeilingFailed: number
  readonly descriptionCalls: number
  readonly elapsedMs: number
  readonly outcomes: readonly EnhancementOutcome[]
}

export interface EnhancementWorkerDependencies {
  readonly drive: DriveDownloader
  readonly repository: EnhancementRepository
  readonly store: ImmutableObjectStore
  readonly describer: JewelleryDescriber
  readonly enhancer: ImageEnhancer
  readonly config: EnhancementConfig
  readonly now?: () => number
}

interface RecoveredGeneration {
  readonly image: Buffer
  readonly costUsd: number
  readonly model: string
  readonly width: number
  readonly height: number
}

function md5(input: Buffer): string {
  return createHash('md5').update(input).digest('hex')
}

function originalExtension(mimeType: string): 'jpg' | 'png' | 'webp' | 'gif' | 'tiff' {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/tiff') return 'tiff'
  throw new EnhancementError(
    `The file format is ${mimeType}. Loupe can enhance JPEG, PNG, WebP, GIF or TIFF images.`,
    {
      stage: 'input',
      code: 'unsupported_mime_type',
      retryable: false,
      detail: { mime_type: mimeType },
    },
  )
}

function expectedDimensions(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number)
  if (!width || !height) {
    throw new EnhancementError(`IMAGE_SIZE "${size}" is invalid.`, {
      stage: 'image',
      code: 'invalid_image_size_config',
      retryable: false,
    })
  }
  return { width, height }
}

function requiredMetadata(
  object: StoredObject,
  key: string,
): string {
  const value = object.metadata[key]?.trim()
  if (!value) {
    throw new EnhancementError(
      `The recoverable R2 object ${object.key} is missing metadata "${key}".`,
      {
        stage: 'storage',
        code: 'r2_orphan_metadata_missing',
        retryable: false,
        detail: object,
      },
    )
  }
  return value
}

function numberMetadata(object: StoredObject, key: string): number {
  const value = Number(requiredMetadata(object, key))
  if (!Number.isFinite(value) || value < 0) {
    throw new EnhancementError(
      `The recoverable R2 object ${object.key} has invalid metadata "${key}".`,
      {
        stage: 'storage',
        code: 'r2_orphan_metadata_invalid',
        retryable: false,
        detail: object,
      },
    )
  }
  return value
}

async function requireLease(
  repository: EnhancementRepository,
  claim: EnhancementClaim,
): Promise<void> {
  if (await repository.assertLease(claim.id, claim.leaseToken)) return
  throw new EnhancementError(
    `Enhancement ownership for ${claim.id} expired or was revoked. The stale worker result was discarded.`,
    {
      stage: 'fencing',
      code: 'stale_enhancement_worker',
      retryable: false,
      detail: { intake_file_id: claim.id },
    },
  )
}

async function recoverGeneration(
  store: ImmutableObjectStore,
  object: StoredObject,
  expected: {
    readonly intakeFileId: string
    readonly sourceSha256: string
    readonly promptSha256: string
    readonly requestedModel: string
    readonly size: string
    readonly quality: string
    readonly descriptionInjected: boolean
    readonly descriptionMissing: boolean
  },
): Promise<RecoveredGeneration> {
  const actualModel = requiredMetadata(object, 'model')
  const actual = {
    intakeFileId: requiredMetadata(object, 'intake-id'),
    sourceSha256: requiredMetadata(object, 'source-sha256'),
    promptSha256: requiredMetadata(object, 'prompt-sha256'),
    requestedModel: requiredMetadata(object, 'requested-model'),
    size: requiredMetadata(object, 'image-size'),
    quality: requiredMetadata(object, 'image-quality'),
    descriptionInjected: requiredMetadata(object, 'description-injected') === 'true',
    descriptionMissing: requiredMetadata(object, 'description-missing') === 'true',
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new EnhancementError(
      `R2 contains an uncommitted version for ${expected.intakeFileId}, but its generation inputs differ. It was left untouched for operator review.`,
      {
        stage: 'storage',
        code: 'r2_orphan_generation_conflict',
        retryable: false,
        detail: { key: object.key, expected, actual },
      },
    )
  }

  return {
    image: await store.get(object.key),
    costUsd: numberMetadata(object, 'cost-usd'),
    model: actualModel,
    width: numberMetadata(object, 'width'),
    height: numberMetadata(object, 'height'),
  }
}

function descriptionFailure(error: unknown): EnhancementError {
  if (error instanceof EnhancementError && error.stage === 'describe') return error
  return new EnhancementError('The jewellery description could not be generated.', {
    stage: 'describe',
    code: 'description_failed',
    retryable: true,
    detail: error,
  })
}

async function processClaim(
  claim: EnhancementClaim,
  dependencies: EnhancementWorkerDependencies,
): Promise<EnhancementOutcome> {
  const { drive, repository, store, describer, enhancer, config } = dependencies
  let descriptionCalled = false
  let descriptionInjected = false
  let descriptionMissing = claim.descriptionMissingAt !== null
  let presentationClass: PresentationClass | null = claim.presentationClass
  let presentationFallbackReason = claim.presentationFallbackReason

  try {
    const original = await drive.downloadFile(claim.driveFileId)
    if (claim.bytes !== null && original.byteLength !== claim.bytes) {
      throw new EnhancementError(
        `Drive returned ${original.byteLength} bytes for ${claim.filename}, but discovery recorded ${claim.bytes}.`,
        {
          stage: 'drive',
          code: 'drive_size_changed',
          retryable: false,
          detail: { expected: claim.bytes, actual: original.byteLength },
        },
      )
    }
    if (claim.driveMd5 && md5(original) !== claim.driveMd5.toLowerCase()) {
      throw new EnhancementError(
        `The Drive checksum changed for ${claim.filename}. Reconcile the source file before enhancing it.`,
        {
          stage: 'drive',
          code: 'drive_checksum_changed',
          retryable: false,
          detail: { expected: claim.driveMd5, actual: md5(original) },
        },
      )
    }

    const phash = await perceptualHash(original)
    await repository.storePerceptualHash({
      intakeFileId: claim.id,
      leaseToken: claim.leaseToken,
      phash,
      source: SOURCE,
    })

    const prepared = await prepareModelInput(original)
    const sourceSha256 = sha256(original)
    const originalKey = `originals/${claim.id}.${originalExtension(claim.mimeType)}`

    await requireLease(repository, claim)
    await store.putImmutable(originalKey, original, claim.mimeType, {
      'intake-id': claim.id,
      'drive-file-id': claim.driveFileId,
      'source-sha256': sourceSha256,
    })

    const prompts = await repository.loadLivePrompts()
    let productDescription = claim.productDescription

    if (productDescription && !presentationClass) {
      const compatibility = await repository.ensurePresentationFallback({
        intakeFileId: claim.id,
        leaseToken: claim.leaseToken,
        reason: 'legacy_missing_presentation_class',
        source: SOURCE,
      })
      presentationClass = compatibility.presentationClass
    }

    if (!productDescription && !descriptionMissing) {
      descriptionCalled = true
      let result: DescriptionResult | null = null
      try {
        result = await describer.describe(
          prepared.buffer,
          prepared.mediaType,
          prompts.describe.body,
          {
            model: prompts.describe.model,
            reasoningEffort: config.describeReasoningEffort,
          },
        )
        if (result.costUsd > config.maxCostUsdPerDescription) {
          throw new EnhancementError(
            `Description cost $${result.costUsd} exceeded the $${config.maxCostUsdPerDescription} description ceiling.`,
            {
              stage: 'describe',
              code: 'description_cost_ceiling_exceeded',
              retryable: true,
              detail: {
                actual_cost_usd: result.costUsd,
                max_cost_usd: config.maxCostUsdPerDescription,
                request_id: result.requestId,
              },
            },
          )
        }
      } catch (error) {
        // A successful response can still fail the independent cost guard.
        // Never cache/inject that response after its failure transition.
        result = null
        const failure = descriptionFailure(error)
        const recorded = await repository.recordDescriptionFailure({
          intakeFileId: claim.id,
          leaseToken: claim.leaseToken,
          message: failure.message,
          code: failure.code,
          detail: safeErrorDetail(failure),
          source: SOURCE,
        })
        if (!recorded.proceedWithoutDescription) {
          return {
            intakeFileId: claim.id,
            status: 'retry_scheduled',
            attempts: recorded.attempts,
            descriptionCalled,
            descriptionInjected: false,
            descriptionMissing: false,
          }
        }
        descriptionMissing = true
        presentationClass = recorded.presentationClass
        presentationFallbackReason = recorded.presentationFallbackReason
      }

      if (result !== null) {
        const cached = await repository.storeDescription({
          intakeFileId: claim.id,
          leaseToken: claim.leaseToken,
          description: result.text,
          presentationClass: result.presentation,
          model: result.model,
          costUsd: result.costUsd,
          source: SOURCE,
        })
        productDescription = cached.text
        presentationClass = cached.presentationClass
      }
    }

    if (!presentationClass) {
      const fallback = await repository.ensurePresentationFallback({
        intakeFileId: claim.id,
        leaseToken: claim.leaseToken,
        reason:
          presentationFallbackReason ??
          'legacy_missing_presentation_class',
        source: SOURCE,
      })
      presentationClass = fallback.presentationClass
    }

    const resolvedPrompt = resolveImagePrompt(
      prompts.image.body,
      productDescription,
      config.injectDescription,
      descriptionMissing,
      presentationClass,
      prompts.image.usesComposition,
    )
    descriptionInjected = resolvedPrompt.descriptionInjected
    descriptionMissing = resolvedPrompt.descriptionMissing

    const generatedKey = `versions/${claim.id}/v1.png`
    const thumbKey = `versions/${claim.id}/v1_thumb.webp`
    const promptSha256 = sha256(resolvedPrompt.text)
    const expected = expectedDimensions(config.imageSize)
    const existing = await store.head(generatedKey)

    let generated: RecoveredGeneration
    if (existing) {
      generated = await recoverGeneration(store, existing, {
        intakeFileId: claim.id,
        sourceSha256,
        promptSha256,
        requestedModel: prompts.image.model,
        size: config.imageSize,
        quality: config.imageQuality,
        descriptionInjected,
        descriptionMissing,
      })
    } else {
      const result = await enhancer.enhance(
        prepared.buffer,
        prepared.mediaType,
        resolvedPrompt.text,
        {
          model: prompts.image.model,
          size: config.imageSize,
          quality: config.imageQuality,
        },
      )
      const generatedImage = await normaliseGeneratedImage(result.image, expected)
      const actual = await readImageDimensions(generatedImage)

      const metadata = {
        'intake-id': claim.id,
        'version-no': '1',
        'source-sha256': sourceSha256,
        'prompt-sha256': promptSha256,
        model: result.model,
        'requested-model': prompts.image.model,
        'image-size': config.imageSize,
        'image-quality': config.imageQuality,
        'cost-usd': result.costUsd.toString(),
        width: actual.width.toString(),
        height: actual.height.toString(),
        'description-injected': String(descriptionInjected),
        'description-missing': String(descriptionMissing),
        ...(result.generationId ? { 'generation-id': result.generationId } : {}),
      }
      const thumbnail = await makeThumbnail(generatedImage)

      await requireLease(repository, claim)
      await store.putImmutable(generatedKey, generatedImage, 'image/png', metadata)
      await requireLease(repository, claim)
      await store.putImmutable(thumbKey, thumbnail, 'image/webp', {
        'intake-id': claim.id,
        'version-no': '1',
        'source-sha256': sourceSha256,
        'prompt-sha256': promptSha256,
      })

      generated = {
        image: generatedImage,
        costUsd: result.costUsd,
        model: result.model,
        width: actual.width,
        height: actual.height,
      }
    }

    if (!(await store.head(thumbKey))) {
      const thumbnail = await makeThumbnail(generated.image)
      await requireLease(repository, claim)
      await store.putImmutable(thumbKey, thumbnail, 'image/webp', {
        'intake-id': claim.id,
        'version-no': '1',
        'source-sha256': sourceSha256,
        'prompt-sha256': promptSha256,
      })
    }

    await requireLease(repository, claim)
    const completion = await repository.complete({
      intakeFileId: claim.id,
      leaseToken: claim.leaseToken,
      originalStorageKey: originalKey,
      originalWidth: prepared.originalWidth,
      originalHeight: prepared.originalHeight,
      generatedStorageKey: generatedKey,
      thumbKey,
      generatedWidth: generated.width,
      generatedHeight: generated.height,
      model: generated.model,
      promptText: resolvedPrompt.text,
      costUsd: generated.costUsd,
      maxCostUsd: config.maxCostUsdPerImage,
      descriptionInjected,
      descriptionMissing,
      source: SOURCE,
    })

    return {
      intakeFileId: claim.id,
      status: completion.status === 'enhanced' ? 'enhanced' : 'cost_ceiling_failed',
      attempts: completion.attempts,
      imageVersionId: completion.imageVersionId,
      costUsd: completion.costUsd,
      descriptionCalled,
      descriptionInjected,
      descriptionMissing,
    }
  } catch (rawError) {
    if (rawError instanceof EnhancementRepositoryError) {
      if (!(await repository.assertLease(claim.id, claim.leaseToken).catch(() => false))) {
        throw new EnhancementError(
          `Enhancement ownership for ${claim.id} expired or was revoked. The stale worker result was discarded.`,
          {
            stage: 'fencing',
            code: 'stale_enhancement_worker',
            retryable: false,
            detail: rawError.detail,
          },
        )
      }
    }

    const error =
      rawError instanceof EnhancementRepositoryError
        ? new EnhancementError(rawError.message, {
            stage: 'database',
            code: 'enhancement_database_error',
            retryable: rawError.retryable,
            detail: rawError.detail,
          })
        : classifyWorkerError(rawError)
    if (error.stage === 'fencing') throw error
    if (!(await repository.assertLease(claim.id, claim.leaseToken))) {
      throw new EnhancementError(
        `Enhancement ownership for ${claim.id} expired or was revoked. The stale worker result was discarded.`,
        {
          stage: 'fencing',
          code: 'stale_enhancement_worker',
          retryable: false,
          detail: error.detail,
        },
      )
    }

    const failure = await repository.recordFailure({
      intakeFileId: claim.id,
      leaseToken: claim.leaseToken,
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      detail: safeErrorDetail(error),
      source: SOURCE,
    })
    return {
      intakeFileId: claim.id,
      status: failure.status === 'failed' ? 'failed' : 'retry_scheduled',
      attempts: failure.attempts,
      descriptionCalled,
      descriptionInjected,
      descriptionMissing,
    }
  }
}

export async function runEnhancementBatch(
  dependencies: EnhancementWorkerDependencies,
  options: {
    readonly maxItems?: number
    readonly timeBudgetMs?: number
  } = {},
): Promise<EnhancementBatchResult> {
  const now = dependencies.now ?? Date.now
  const started = now()
  const maxItems = Math.min(Math.max(options.maxItems ?? MAX_BATCH_SIZE, 1), MAX_BATCH_SIZE)
  const budget = Math.max(options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS, 1)
  const outcomes: EnhancementOutcome[] = []

  while (outcomes.length < maxItems && now() - started < budget) {
    const claim = await dependencies.repository.claim(LEASE_SECONDS)
    if (!claim) break
    outcomes.push(await processClaim(claim, dependencies))
  }

  return {
    claimed: outcomes.length,
    enhanced: outcomes.filter((row) => row.status === 'enhanced').length,
    retryScheduled: outcomes.filter((row) => row.status === 'retry_scheduled').length,
    failed: outcomes.filter((row) => row.status === 'failed').length,
    costCeilingFailed: outcomes.filter((row) => row.status === 'cost_ceiling_failed').length,
    descriptionCalls: outcomes.filter((row) => row.descriptionCalled).length,
    elapsedMs: now() - started,
    outcomes,
  }
}
