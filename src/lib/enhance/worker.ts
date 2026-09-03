import { createHash } from 'node:crypto'

import type { DriveDownloader } from '@/lib/google/drive-types'
import { perceptualHash } from '@/lib/duplicates/phash'

import {
  type CheckFailureCode,
  checkPrompt,
  parseCheckCodes,
  retryPromptFor,
  serialiseCheckCodes,
} from './check'
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
  RenderChecker,
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
/**
 * Photographs claimed per tick, processed CONCURRENTLY.
 *
 * The tick fires once a minute, so this is also the throughput ceiling: four
 * per minute, 100 photographs in ~25 ticks. Raising it without going parallel
 * would not help — four sequential calls at ~65 s each overrun the 240 s budget
 * and the 300 s Vercel limit, so the fourth would never be reached.
 *
 * Concurrency does NOT change what a photograph costs, only how fast the
 * catalogue's fixed cost is paid. What it does change is how much an unnoticed
 * mistake accumulates before a human looks — see D68.
 */
const MAX_BATCH_SIZE = 4
const DEFAULT_TIME_BUDGET_MS = 240_000

export type EnhancementOutcomeStatus =
  | 'enhanced'
  | 'retry_scheduled'
  | 'failed'
  | 'cost_ceiling_failed'
  /**
   * The provider account could not pay for the call. Nothing was recorded
   * against the photograph: its lease is left to expire so the sweeper returns
   * it to `discovered` with `attempts` unchanged.
   */
  | 'provider_quota_paused'

/**
 * Trips the moment one claim in this tick sees a provider quota refusal, so the
 * siblings do not each make the same doomed paid request. Scoped to one tick —
 * the next tick retries once, which is how the queue notices a top-up.
 */
interface QuotaBreaker {
  tripped: EnhancementError | null
}

export interface EnhancementOutcome {
  readonly intakeFileId: string
  /** Carried out so terminal failures can be swept out of Drive /Raw. */
  readonly driveFileId: string
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
  /** Claims whose lease was taken by a replacement worker mid-flight. */
  readonly stale: number
  readonly enhanced: number
  readonly retryScheduled: number
  readonly failed: number
  readonly costCeilingFailed: number
  /** Claims abandoned unchanged because the provider account cannot pay. */
  readonly providerQuotaPaused: number
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
  /** D120 — verifies each fresh render; consulted only when config.checkEnabled. */
  readonly checker: RenderChecker
  readonly config: EnhancementConfig
  readonly now?: () => number
}

interface RecoveredGeneration {
  readonly image: Buffer
  readonly costUsd: number
  readonly model: string
  readonly width: number
  readonly height: number
  /** D120 — which render attempt produced the stored object (1 when unset). */
  readonly renderAttempt: number
  readonly checkVerdict: 'pass' | 'fail' | 'skipped'
  readonly checkCodes: readonly CheckFailureCode[]
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

  // D120 metadata is optional: objects written before the checker existed
  // recover as a single unchecked attempt.
  const recoveredAttempt = Number(object.metadata['render-attempt'] ?? '1')
  const recoveredVerdict = object.metadata['check-verdict']
  return {
    image: await store.get(object.key),
    costUsd: numberMetadata(object, 'cost-usd'),
    model: actualModel,
    width: numberMetadata(object, 'width'),
    height: numberMetadata(object, 'height'),
    renderAttempt: Number.isInteger(recoveredAttempt) && recoveredAttempt > 1 ? recoveredAttempt : 1,
    checkVerdict:
      recoveredVerdict === 'pass' || recoveredVerdict === 'fail' ? recoveredVerdict : 'skipped',
    checkCodes: parseCheckCodes(object.metadata['check-codes'] ?? ''),
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
  breaker: QuotaBreaker = { tripped: null },
): Promise<EnhancementOutcome> {
  const { drive, repository, store, describer, enhancer, checker, config } = dependencies
  let descriptionCalled = false
  let descriptionInjected = false
  let descriptionMissing = claim.descriptionMissingAt !== null
  let presentationClass: PresentationClass | null = claim.presentationClass
  let presentationFallbackReason = claim.presentationFallbackReason

  try {
    if (breaker.tripped) throw breaker.tripped
    // D103: a browser-uploaded source lives in R2 already; everything after
    // this line is identical to the Drive path.
    const original = claim.sourceStorageKey
      ? await store.get(claim.sourceStorageKey)
      : await drive.downloadFile(claim.driveFileId)
    if (claim.bytes !== null && original.byteLength !== claim.bytes) {
      throw new EnhancementError(
        `The source returned ${original.byteLength} bytes for ${claim.filename}, but discovery recorded ${claim.bytes}.`,
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

    // D103: a photograph may carry its own prompt pair. A missing or
    // half-missing bound pair falls back to the live default whole — never a
    // mixed pair, whose two halves were not written together.
    const prompts =
      (claim.presetSlug ? await repository.loadPromptsForPreset(claim.presetSlug) : null) ??
      (await repository.loadLivePrompts())
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
        // Credit exhaustion belongs to the provider account, not to the
        // descriptor retry budget. Let the outer handler place this exact
        // photograph into the same explicit provider-pause state as image
        // generation instead of spending an attempt on a guaranteed 402.
        if (failure.quota) throw failure
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
            driveFileId: claim.driveFileId,
            status: recorded.status === 'failed' ? 'failed' : 'retry_scheduled',
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
      // Best-effort: siblings already past this point cannot be recalled, but a
      // claim still downloading or describing skips a request the account
      // provably cannot pay for. A 402 is refused before generation, so the
      // wasted calls cost nothing either way.
      if (breaker.tripped) throw breaker.tripped

      // D120 — generate, verify, retry once bounded. The render is held in
      // memory until its verdict is known, so R2 only ever holds the accepted
      // render at the immutable v1 key. The retry prompt is a deterministic
      // function of (base prompt, failure codes); metadata records the attempt
      // and codes so recovery can reconstruct the exact bytes sent.
      let attempt = 1
      let promptText = resolvedPrompt.text
      let totalRenderCostUsd = 0
      let checkCostUsd = 0
      let checkVerdict: 'pass' | 'fail' | 'skipped' = 'skipped'
      let checkCodes: readonly CheckFailureCode[] = []
      // The codes the CURRENT promptText was built with — distinct from the
      // final verdict's codes, because a retry that then passes clears the
      // verdict but its prompt was still built from the first failure.
      let retryCodes: readonly CheckFailureCode[] = []
      let checkFailures: readonly { code: CheckFailureCode; detail: string }[] = []
      let checkError: string | null = null
      let checkCeilingBreached = false
      let result
      let generatedImage: Buffer
      let actual
      for (;;) {
        result = await enhancer.enhance(prepared.buffer, prepared.mediaType, promptText, {
          model: prompts.image.model,
          size: config.imageSize,
          quality: config.imageQuality,
        })
        generatedImage = await normaliseGeneratedImage(result.image, expected)
        actual = await readImageDimensions(generatedImage)
        totalRenderCostUsd += result.costUsd

        if (!config.checkEnabled) break
        try {
          const checked = await checker.check(
            prepared.buffer,
            prepared.mediaType,
            generatedImage,
            checkPrompt(productDescription),
            { model: config.checkModel },
          )
          checkCostUsd += checked.costUsd
          // The verdict is already paid for, so a ceiling breach is recorded
          // rather than discarded — unlike the describe ceiling, refusing here
          // would spend more to know less.
          if (checked.costUsd > config.maxCostUsdPerCheck) checkCeilingBreached = true
          if (checked.verdict.pass) {
            checkVerdict = 'pass'
            checkCodes = []
            checkFailures = []
            break
          }
          checkVerdict = 'fail'
          checkFailures = checked.verdict.failures
          checkCodes = checked.verdict.failures.map((failure) => failure.code)
        } catch (error) {
          // Fail-open: a checker fault must never stop the queue or fail the
          // photograph. The render is accepted unchecked and the fault recorded.
          checkVerdict = 'skipped'
          checkError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          break
        }

        if (attempt >= config.maxRenderAttempts) break
        attempt += 1
        retryCodes = checkCodes
        promptText = retryPromptFor(resolvedPrompt.text, retryCodes)
        if (breaker.tripped) throw breaker.tripped
      }

      const metadata = {
        'intake-id': claim.id,
        'version-no': '1',
        'source-sha256': sourceSha256,
        // Deliberately the BASE resolved prompt's hash even for a retry render:
        // it is the identity of the job, which recovery compares. The retry
        // suffix is reconstructed from render-attempt + check-codes.
        'prompt-sha256': promptSha256,
        model: result.model,
        'requested-model': prompts.image.model,
        'image-size': config.imageSize,
        'image-quality': config.imageQuality,
        'cost-usd': totalRenderCostUsd.toString(),
        width: actual.width.toString(),
        height: actual.height.toString(),
        'description-injected': String(descriptionInjected),
        'description-missing': String(descriptionMissing),
        'render-attempt': String(attempt),
        'check-verdict': checkVerdict,
        // The codes the stored render's prompt was built with, so recovery can
        // reconstruct the exact bytes sent. The final verdict's codes travel in
        // the enhancement.render_check event.
        'check-codes': serialiseCheckCodes(retryCodes),
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

      // Per-photograph audit of what verification saw and spent. Best-effort:
      // an event write must never fail a completed enhancement.
      if (config.checkEnabled) {
        await repository
          .recordSystemEvent({
            event: 'enhancement.render_check',
            detail: {
              intake_file_id: claim.id,
              verdict: checkVerdict,
              codes: checkCodes,
              failures: checkFailures,
              render_attempts: attempt,
              render_cost_usd: totalRenderCostUsd,
              check_cost_usd: checkCostUsd,
              check_model: config.checkModel,
              ...(checkError ? { check_error: checkError } : {}),
              ...(checkCeilingBreached
                ? { check_cost_ceiling_breached: config.maxCostUsdPerCheck }
                : {}),
            },
            actor: SOURCE,
          })
          .catch(() => undefined)
      }

      generated = {
        image: generatedImage,
        costUsd: totalRenderCostUsd,
        model: result.model,
        width: actual.width,
        height: actual.height,
        renderAttempt: attempt,
        checkVerdict,
        checkCodes: retryCodes,
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
      // The exact bytes sent for the accepted render: the base resolved prompt,
      // plus the deterministic correction suffix when it took a retry.
      promptText:
        generated.renderAttempt > 1
          ? retryPromptFor(resolvedPrompt.text, generated.checkCodes)
          : resolvedPrompt.text,
      costUsd: generated.costUsd,
      maxCostUsd: config.maxCostUsdPerImage,
      descriptionInjected,
      descriptionMissing,
      source: SOURCE,
    })

    return {
      intakeFileId: claim.id,
      driveFileId: claim.driveFileId,
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

    // A quota refusal says the account cannot pay — it says nothing about this
    // photograph. Recording it as a normal failure would spend the retry budget
    // and eventually mark a good source `failed`. Release the lease into an
    // explicit provider pause instead; Tracking tells the operator what to fix
    // and offers Resume enhancement while completed attempts stay untouched.
    if (error.quota) {
      breaker.tripped ??= error
      const paused = await repository.pauseForProviderQuota({
        intakeFileId: claim.id,
        leaseToken: claim.leaseToken,
        message: error.message,
        code: error.code,
        detail: safeErrorDetail(error),
        stage: error.stage,
        source: SOURCE,
      })
      return {
        intakeFileId: claim.id,
        driveFileId: claim.driveFileId,
        status: 'provider_quota_paused',
        attempts: paused.attempts,
        descriptionCalled,
        descriptionInjected,
        descriptionMissing,
      }
    }

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
      driveFileId: claim.driveFileId,
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
  // Claims are taken one at a time on purpose: each is a single atomic
  // UPDATE … RETURNING that takes the row lock, so concurrent claims would
  // serialise on the database anyway. Only the slow part — download, describe,
  // generate, upload — runs in parallel.
  const claims: EnhancementClaim[] = []
  while (claims.length < maxItems && now() - started < budget) {
    const claim = await dependencies.repository.claim(LEASE_SECONDS)
    if (!claim) break
    claims.push(claim)
  }

  // allSettled, not all. processClaim rethrows when THIS worker has lost its
  // lease to a replacement — a fact about one photograph. Letting it reject the
  // whole batch would discard three siblings' finished work from the result,
  // and their rows are already written and correct.
  const breaker: QuotaBreaker = { tripped: null }
  const settled = await Promise.allSettled(
    claims.map((claim) => processClaim(claim, dependencies, breaker)),
  )
  const outcomes = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  const stale = settled.length - outcomes.length
  if (stale > 0 && outcomes.length === 0) {
    throw (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
  }

  const providerQuotaPaused = outcomes.filter(
    (row) => row.status === 'provider_quota_paused',
  ).length

  // One row per tick, not per photograph: the condition belongs to the account.
  // Best-effort — a pause must never itself become a failure.
  if (breaker.tripped) {
    await dependencies.repository
      .recordSystemEvent({
        event: 'enhancement.paused_provider_quota',
        detail: {
          code: breaker.tripped.code,
          stage: breaker.tripped.stage,
          message: breaker.tripped.message,
          claims_released: providerQuotaPaused,
        },
        actor: SOURCE,
      })
      .catch(() => undefined)
  }

  return {
    claimed: claims.length,
    stale,
    enhanced: outcomes.filter((row) => row.status === 'enhanced').length,
    retryScheduled: outcomes.filter((row) => row.status === 'retry_scheduled').length,
    failed: outcomes.filter((row) => row.status === 'failed').length,
    costCeilingFailed: outcomes.filter((row) => row.status === 'cost_ceiling_failed').length,
    providerQuotaPaused,
    descriptionCalls: outcomes.filter((row) => row.descriptionCalled).length,
    elapsedMs: now() - started,
    outcomes,
  }
}
