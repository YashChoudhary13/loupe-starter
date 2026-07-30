import {
  classifyWorkerError,
  EnhancementError,
} from './errors'
import {
  makeThumbnail,
  normaliseGeneratedImage,
  prepareModelInput,
  readImageDimensions,
} from './image'
import type { ImageEnhancer } from './openrouter'
import type {
  RedoClaim,
  RedoRepository,
} from './redo-repository'
import {
  sha256,
  type ImmutableObjectStore,
  type StoredObject,
} from './storage'
import type { EnhancementConfig } from './config'

const SOURCE = 'redo-worker'
const LEASE_SECONDS = 300

export interface RedoWorkerDependencies {
  readonly repository: RedoRepository
  readonly store: ImmutableObjectStore
  readonly enhancer: ImageEnhancer
  readonly config: EnhancementConfig
}

export interface RedoBatchResult {
  readonly claimed: number
  readonly completed: number
  readonly retryScheduled: number
  readonly failed: number
  readonly paidCalls: number
  readonly recovered: number
  readonly jobId: string | null
  readonly imageVersionId: string | null
  readonly versionNo: number | null
  readonly costUsd: number | null
}

interface GeneratedRedo {
  readonly image: Buffer
  readonly model: string
  readonly costUsd: number
  readonly width: number
  readonly height: number
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

function requiredMetadata(object: StoredObject, key: string): string {
  const value = object.metadata[key]?.trim()
  if (!value) {
    throw new EnhancementError(
      `The recoverable redo object ${object.key} is missing metadata "${key}".`,
      {
        stage: 'storage',
        code: 'redo_orphan_metadata_missing',
        retryable: false,
        detail: { key: object.key, metadata_key: key },
      },
    )
  }
  return value
}

function numberMetadata(object: StoredObject, key: string): number {
  const number = Number(requiredMetadata(object, key))
  if (!Number.isFinite(number) || number < 0) {
    throw new EnhancementError(
      `The recoverable redo object ${object.key} has invalid metadata "${key}".`,
      {
        stage: 'storage',
        code: 'redo_orphan_metadata_invalid',
        retryable: false,
      },
    )
  }
  return number
}

async function requireLease(
  repository: RedoRepository,
  claim: RedoClaim,
): Promise<void> {
  if (await repository.assertLease(claim.id, claim.leaseToken)) return
  throw new EnhancementError('The redo lease expired; this stale result was discarded.', {
    stage: 'fencing',
    code: 'stale_redo_worker',
    retryable: false,
    detail: { job_id: claim.id },
  })
}

async function recoverRedo(
  store: ImmutableObjectStore,
  object: StoredObject,
  expected: Readonly<Record<string, string>>,
): Promise<GeneratedRedo> {
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, requiredMetadata(object, key)]),
  )
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new EnhancementError(
      `R2 contains an uncommitted result for redo ${expected['redo-job-id']}, but its inputs differ.`,
      {
        stage: 'storage',
        code: 'redo_orphan_generation_conflict',
        retryable: false,
        detail: { key: object.key, expected, actual },
      },
    )
  }
  return {
    image: await store.get(object.key),
    model: requiredMetadata(object, 'model'),
    costUsd: numberMetadata(object, 'cost-usd'),
    width: numberMetadata(object, 'width'),
    height: numberMetadata(object, 'height'),
  }
}

async function processRedo(
  claim: RedoClaim,
  dependencies: RedoWorkerDependencies,
): Promise<RedoBatchResult> {
  const { repository, store, enhancer, config } = dependencies
  const generatedKey = `versions/${claim.intakeFileId}/v${claim.versionNo}.png`
  const thumbKey = `versions/${claim.intakeFileId}/v${claim.versionNo}_thumb.webp`
  let paidRequestStarted = claim.generationStartedAt !== null
  let paidCalls = 0
  let recovered = 0

  try {
    const original = await store.get(claim.sourceStorageKey)
    const prepared = await prepareModelInput(original)
    const sourceSha256 = sha256(original)
    const promptSha256 = sha256(claim.promptText)
    const expected = expectedDimensions(config.imageSize)
    const recoveryInputs = {
      'redo-job-id': claim.id,
      'intake-id': claim.intakeFileId,
      'version-no': String(claim.versionNo),
      'source-sha256': sourceSha256,
      'prompt-sha256': promptSha256,
      'requested-model': claim.model,
      'image-size': config.imageSize,
      'image-quality': config.imageQuality,
      'description-injected': String(claim.descriptionInjected),
      'description-missing': String(claim.descriptionMissing),
    } as const

    const existing = await store.head(generatedKey)
    let generated: GeneratedRedo
    if (existing) {
      generated = await recoverRedo(store, existing, recoveryInputs)
      recovered = 1
    } else {
      if (paidRequestStarted) {
        throw new EnhancementError(
          'The previous redo request may have been billed, but no durable image was stored. Loupe will not call the model twice automatically.',
          {
            stage: 'image',
            code: 'redo_generation_outcome_unknown',
            retryable: false,
            detail: { job_id: claim.id },
          },
        )
      }

      await requireLease(repository, claim)
      await repository.markGenerationStarted(claim.id, claim.leaseToken)
      paidRequestStarted = true
      paidCalls = 1

      const result = await enhancer.enhance(
        prepared.buffer,
        prepared.mediaType,
        claim.promptText,
        {
          model: claim.model,
          size: config.imageSize,
          quality: config.imageQuality,
        },
      )
      const image = await normaliseGeneratedImage(result.image, expected)
      const dimensions = await readImageDimensions(image)
      const thumbnail = await makeThumbnail(image)
      const metadata = {
        ...recoveryInputs,
        model: result.model,
        'cost-usd': String(result.costUsd),
        width: String(dimensions.width),
        height: String(dimensions.height),
        ...(result.generationId ? { 'generation-id': result.generationId } : {}),
      }

      await requireLease(repository, claim)
      await store.putImmutable(generatedKey, image, 'image/png', metadata)
      await requireLease(repository, claim)
      await store.putImmutable(thumbKey, thumbnail, 'image/webp', {
        'redo-job-id': claim.id,
        'intake-id': claim.intakeFileId,
        'version-no': String(claim.versionNo),
        'source-sha256': sourceSha256,
        'prompt-sha256': promptSha256,
      })

      generated = {
        image,
        model: result.model,
        costUsd: result.costUsd,
        width: dimensions.width,
        height: dimensions.height,
      }
    }

    if (!(await store.head(thumbKey))) {
      const thumbnail = await makeThumbnail(generated.image)
      await requireLease(repository, claim)
      await store.putImmutable(thumbKey, thumbnail, 'image/webp', {
        'redo-job-id': claim.id,
        'intake-id': claim.intakeFileId,
        'version-no': String(claim.versionNo),
        'source-sha256': sourceSha256,
        'prompt-sha256': promptSha256,
      })
    }

    await requireLease(repository, claim)
    const completion = await repository.complete({
      jobId: claim.id,
      leaseToken: claim.leaseToken,
      storageKey: generatedKey,
      thumbKey,
      width: generated.width,
      height: generated.height,
      actualModel: generated.model,
      costUsd: generated.costUsd,
      maxCostUsd: config.maxCostUsdPerImage,
      source: SOURCE,
    })

    return {
      claimed: 1,
      completed: completion.status === 'completed' ? 1 : 0,
      retryScheduled: 0,
      failed: completion.status === 'failed' ? 1 : 0,
      paidCalls,
      recovered,
      jobId: claim.id,
      imageVersionId: completion.imageVersionId,
      versionNo: completion.versionNo,
      costUsd: completion.costUsd,
    }
  } catch (cause) {
    const failure = classifyWorkerError(cause)
    const recorded = await repository.recordFailure({
      jobId: claim.id,
      leaseToken: claim.leaseToken,
      message: failure.message,
      code: failure.code,
      // Once dispatch begins, even a timeout has an ambiguous billing outcome.
      retryable: failure.retryable && !paidRequestStarted,
      source: SOURCE,
    })
    return {
      claimed: 1,
      completed: 0,
      retryScheduled: recorded.status === 'queued' ? 1 : 0,
      failed: recorded.status === 'failed' ? 1 : 0,
      paidCalls,
      recovered,
      jobId: claim.id,
      imageVersionId: null,
      versionNo: claim.versionNo,
      costUsd: null,
    }
  }
}

export async function runRedoBatch(
  dependencies: RedoWorkerDependencies,
  jobId?: string,
): Promise<RedoBatchResult> {
  const claim = await dependencies.repository.claim(LEASE_SECONDS, jobId)
  if (!claim) {
    return {
      claimed: 0,
      completed: 0,
      retryScheduled: 0,
      failed: 0,
      paidCalls: 0,
      recovered: 0,
      jobId: null,
      imageVersionId: null,
      versionNo: null,
      costUsd: null,
    }
  }
  return processRedo(claim, dependencies)
}
