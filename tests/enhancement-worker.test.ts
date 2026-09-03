import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { EnhancementConfig } from '@/lib/enhance/config'
import { EnhancementError } from '@/lib/enhance/errors'
import type {
  ImageEnhancer,
  JewelleryDescriber,
  RenderChecker,
} from '@/lib/enhance/openrouter'
import { EnhancementRepositoryError } from '@/lib/enhance/repository'
import { runEnhancementBatch } from '@/lib/enhance/worker'

import {
  claim,
  MemoryEnhancementRepository,
  MemoryObjectStore,
  TEST_DESCRIPTION,
} from './helpers/enhancement'

const CONFIG: EnhancementConfig = {
  describeModel: 'openai/gpt-5.6-sol',
  describeReasoningEffort: 'minimal',
  injectDescription: true,
  imageModel: 'openai/gpt-image-2',
  imageSize: '1280x1280',
  imageQuality: 'medium',
  maxCostUsdPerImage: 0.2,
  maxCostUsdPerDescription: 0.02,
  // Checker off by default in this suite: the pre-D120 behaviour under test.
  // The dedicated D120 describe block below turns it on explicitly.
  checkEnabled: false,
  checkModel: 'google/gemini-3.6-flash',
  maxCostUsdPerCheck: 0.02,
  maxRenderAttempts: 2,
}

let source: Buffer
let generated: Buffer

beforeAll(async () => {
  source = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 210, g: 190, b: 120 },
    },
  })
    .jpeg()
    .toBuffer()
  generated = await sharp({
    create: {
      width: 1280,
      height: 1280,
      channels: 3,
      background: { r: 244, g: 236, b: 214 },
    },
  })
    .png()
    .toBuffer()
})

function drive() {
  return { downloadFile: vi.fn(async () => Buffer.from(source)) }
}

function describer(): JewelleryDescriber & { describe: ReturnType<typeof vi.fn> } {
  return {
    describe: vi.fn(async () => ({
      text: TEST_DESCRIPTION,
      presentation: 'pair-upright' as const,
      costUsd: 0.004,
      model: 'openai/gpt-5.6-sol',
      requestId: 'description-1',
    })),
  }
}

function enhancer(costUsd = 0.083): ImageEnhancer & { enhance: ReturnType<typeof vi.fn> } {
  return {
    enhance: vi.fn(async () => ({
      image: Buffer.from(generated),
      costUsd,
      model: 'openai/gpt-image-2',
      generationId: 'generation-1',
    })),
  }
}

function checker(
  verdicts: readonly ({ pass: boolean; failures: { code: 'count' | 'gauge'; detail: string }[] } | Error)[] = [
    { pass: true, failures: [] },
  ],
): RenderChecker & { check: ReturnType<typeof vi.fn> } {
  let call = 0
  return {
    check: vi.fn(async () => {
      const verdict = verdicts[Math.min(call, verdicts.length - 1)]
      call += 1
      if (verdict instanceof Error) throw verdict
      return {
        verdict,
        costUsd: 0.006,
        model: 'google/gemini-3.6-flash',
        requestId: `check-${call}`,
      }
    }),
  }
}

describe('Phase 3B enhancement worker', () => {
  it('uses the models selected on the two current prompt versions', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.prompts = {
      describe: {
        ...repository.prompts.describe,
        model: 'google/gemini-3.5-flash-lite',
      },
      image: {
        ...repository.prompts.image,
        model: 'black-forest-labs/flux.2-pro',
      },
    }
    repository.enqueue(claim('selected-models'))
    const descriptionClient = describer()
    const imageClient = enhancer()

    await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: descriptionClient,
        enhancer: imageClient,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(descriptionClient.describe.mock.calls[0]?.[3]).toMatchObject({
      model: 'google/gemini-3.5-flash-lite',
    })
    expect(imageClient.enhance.mock.calls[0]?.[3]).toMatchObject({
      model: 'black-forest-labs/flux.2-pro',
    })
  })

  it('D103: reads a browser-uploaded source from R2 and never calls Drive', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('uploaded', { sourceStorageKey: 'manual/u1/original.jpg' }))
    const store = new MemoryObjectStore()
    await store.putImmutable('manual/u1/original.jpg', Buffer.from(source), 'image/jpeg', {})
    const driveClient = drive()

    const result = await runEnhancementBatch(
      {
        drive: driveClient,
        repository,
        store,
        describer: describer(),
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({ claimed: 1, enhanced: 1 })
    expect(driveClient.downloadFile).not.toHaveBeenCalled()
  })

  it('D103: a bound preset pair overrides the default prompts; a missing pair falls back whole', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.presetPrompts.set('rings--black-marble-mirror', {
      describe: {
        ...repository.prompts.describe,
        id: 'bound-describe',
        body: 'Describe this ring exactly.',
        model: 'moonshotai/kimi-k3',
      },
      image: {
        ...repository.prompts.image,
        id: 'bound-image',
        body: `Ring hero.\n\nPRODUCT\n{{PRODUCT_DESCRIPTION}}\n\nCOMPOSITION\n{{COMPOSITION_DETAIL}}\n\nOn black marble.`,
      },
    })
    repository.enqueue(claim('bound', { presetSlug: 'rings--black-marble-mirror' }))
    repository.enqueue(claim('unbound-missing-pair', { presetSlug: 'no-such-pair' }))
    const descriptionClient = describer()

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: descriptionClient,
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 2 },
    )

    expect(result).toMatchObject({ claimed: 2, enhanced: 2 })
    const describeBodies = descriptionClient.describe.mock.calls.map(
      (call) => call[2] as string,
    )
    expect(describeBodies).toContain('Describe this ring exactly.')
    expect(describeBodies).toContain(repository.prompts.describe.body)
    const boundCompletion = repository.completions.find((completion) =>
      completion.promptText.includes('On black marble.'),
    )
    expect(boundCompletion).toBeDefined()
  })

  it('describes, injects, stores immutable original/result/thumbnail and completes one row', async () => {
    const repository = new MemoryEnhancementRepository()
    const item = claim('normal')
    repository.enqueue(item)
    const store = new MemoryObjectStore()
    const descriptionClient = describer()
    const imageClient = enhancer()

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store,
        describer: descriptionClient,
        enhancer: imageClient,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({
      claimed: 1,
      enhanced: 1,
      descriptionCalls: 1,
    })
    expect(descriptionClient.describe).toHaveBeenCalledTimes(1)
    expect(repository.storedDescriptions).toEqual([
      expect.objectContaining({
        intakeFileId: item.id,
        description: TEST_DESCRIPTION,
        presentationClass: 'pair-upright',
        costUsd: 0.004,
      }),
    ])
    expect(repository.completions[0]).toMatchObject({
      promptText: expect.stringContaining(`PRODUCT\n${TEST_DESCRIPTION}\n\nCOMPOSITION`),
      descriptionInjected: true,
      descriptionMissing: false,
      generatedWidth: 1280,
      generatedHeight: 1280,
      costUsd: 0.083,
    })
    expect(imageClient.enhance.mock.calls[0]?.[2]).toBe(
      repository.completions[0]?.promptText,
    )
    expect(store.objects.get(`originals/${item.id}.jpg`)?.body.equals(source)).toBe(true)
    expect(store.objects.has(`versions/${item.id}/v1.png`)).toBe(true)
    const thumbnail = store.objects.get(`versions/${item.id}/v1_thumb.webp`)?.body
    expect(thumbnail?.byteLength).toBeGreaterThan(0)
    expect(thumbnail?.byteLength).toBeLessThanOrEqual(65_000)
  })

  it('makes zero describe calls for a cached description and cleanly removes PRODUCT for A/B off', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(
      claim('cached', {
        productDescription: TEST_DESCRIPTION,
        presentationClass: 'pair-upright',
        descriptionModel: 'openai/gpt-5.6-sol',
        describedAt: '2026-07-29T12:00:00.000Z',
        descriptionCostUsd: 0.004,
      }),
    )
    const descriptionClient = describer()

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: descriptionClient,
        enhancer: enhancer(),
        checker: checker(),
        config: { ...CONFIG, injectDescription: false },
      },
      { maxItems: 1 },
    )

    expect(result.descriptionCalls).toBe(0)
    expect(descriptionClient.describe).not.toHaveBeenCalled()
    expect(repository.storedDescriptions).toHaveLength(0)
    expect(repository.completions[0]?.promptText).toContain(
      'Show the exact source pieces upright and face-readable',
    )
    expect(repository.completions[0]).toMatchObject({
      descriptionInjected: false,
      descriptionMissing: false,
    })
  })

  it('shows a terminal error when the third description retry fails', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('describe-fallback', { attempts: 3 }))
    const failedDescriber: JewelleryDescriber = {
      describe: vi.fn(async () => {
        throw new EnhancementError('describer unavailable', {
          stage: 'describe',
          code: 'description_provider_failed',
          retryable: true,
        })
      }),
    }

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: failedDescriber,
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({
      enhanced: 0,
      retryScheduled: 0,
      failed: 1,
      descriptionCalls: 1,
    })
    expect(repository.descriptionFailures).toEqual(['description_provider_failed'])
    expect(repository.presentationFallbacks).toEqual([])
    expect(repository.completions).toEqual([])
  })

  it('uses a queryable flat-curve fallback for a legacy cached description without another describe call', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(
      claim('legacy-description', {
        productDescription: TEST_DESCRIPTION,
        presentationClass: null,
        descriptionModel: 'openai/gpt-5.6-sol',
        describedAt: '2026-07-29T12:00:00.000Z',
        descriptionCostUsd: 0.004,
      }),
    )
    const descriptionClient = describer()

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: descriptionClient,
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({ enhanced: 1, descriptionCalls: 0 })
    expect(descriptionClient.describe).not.toHaveBeenCalled()
    expect(repository.presentationFallbacks).toEqual([
      expect.objectContaining({
        intakeFileId: 'legacy-description',
        reason: 'legacy_missing_presentation_class',
      }),
    ])
    expect(repository.completions[0]?.promptText).toContain(
      'This is the legacy fallback for a flexible necklace or long chain',
    )
  })

  it('routes an invalid structured result through the existing bounded retry policy', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('invalid-structured'))
    const invalidDescriber: JewelleryDescriber = {
      describe: vi.fn(async () => {
        throw new EnhancementError('malformed structured output', {
          stage: 'describe',
          code: 'description_presentation_invalid',
          retryable: true,
          detail: {
            raw_result:
              '{"description":"valid paragraph","presentation":"ring"}',
          },
        })
      }),
    }
    const imageClient = enhancer()

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: invalidDescriber,
        enhancer: imageClient,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({
      retryScheduled: 1,
      enhanced: 0,
      descriptionCalls: 1,
    })
    expect(repository.descriptionFailures).toEqual([
      'description_presentation_invalid',
    ])
    expect(repository.presentationFallbacks).toHaveLength(0)
    expect(imageClient.enhance).not.toHaveBeenCalled()
  })

  it('does not repeat an over-ceiling description call', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('description-cost'))
    const expensiveDescriber: JewelleryDescriber = {
      describe: vi.fn(async () => ({
        text: TEST_DESCRIPTION,
        presentation: 'pair-upright' as const,
        costUsd: 0.021,
        model: 'openai/gpt-5.6-sol',
        requestId: 'over-description-ceiling',
      })),
    }

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: expensiveDescriber,
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({ enhanced: 1, descriptionCalls: 1 })
    expect(repository.descriptionFailures).toEqual([
      'description_cost_ceiling_exceeded',
    ])
    expect(repository.storedDescriptions).toHaveLength(0)
    expect(repository.completions[0]).toMatchObject({
      descriptionInjected: false,
      descriptionMissing: true,
    })
  })

  it('retains an over-ceiling image version but permanently fails the intake', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('cost'))

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: describer(),
        enhancer: enhancer(0.25),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({
      enhanced: 0,
      costCeilingFailed: 1,
      failed: 0,
    })
    expect(repository.completions[0]?.costUsd).toBe(0.25)
  })

  it('classifies a permanent image refusal once with a readable failure', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('refusal'))
    const refused: ImageEnhancer = {
      enhance: vi.fn(async () => {
        throw new EnhancementError('The image model refused this photograph.', {
          stage: 'image',
          code: 'image_content_policy',
          retryable: false,
          detail: { raw: 'not returned to operator' },
        })
      }),
    }

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: describer(),
        enhancer: refused,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({ failed: 1, retryScheduled: 0 })
    expect(repository.failures).toEqual([
      expect.objectContaining({
        code: 'image_content_policy',
        retryable: false,
        message: 'The image model refused this photograph.',
      }),
    ])
  })

  it('keeps a database completion outage retryable', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(
      claim('database-outage', {
        productDescription: TEST_DESCRIPTION,
        presentationClass: 'pair-upright',
        descriptionModel: 'openai/gpt-5.6-sol',
        describedAt: '2026-07-29T12:00:00.000Z',
        descriptionCostUsd: 0.004,
      }),
    )
    vi.spyOn(repository, 'complete').mockRejectedValueOnce(
      new EnhancementRepositoryError('Database completion is unavailable.', {
        retryable: true,
        detail: { code: '08006' },
      }),
    )

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: describer(),
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({ failed: 0, retryScheduled: 1 })
    expect(repository.failures).toEqual([
      expect.objectContaining({
        code: 'enhancement_database_error',
        retryable: true,
        message: 'Database completion is unavailable.',
      }),
    ])
  })

  it('recovers a deterministic R2 generation without a second image call', async () => {
    const repository = new MemoryEnhancementRepository()
    const cachedDescription = {
      productDescription: TEST_DESCRIPTION,
      presentationClass: 'pair-upright' as const,
      descriptionModel: 'openai/gpt-5.6-sol',
      describedAt: '2026-07-29T12:00:00.000Z',
      descriptionCostUsd: 0.004,
    }
    repository.enqueue(claim('recover-generation', cachedDescription))
    const store = new MemoryObjectStore()

    await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store,
        describer: describer(),
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    repository.enqueue(
      claim('recover-generation', {
        ...cachedDescription,
        leaseToken: 'lease-recover-generation-retry',
      }),
    )
    const replayEnhancer = enhancer()
    const replay = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store,
        describer: describer(),
        enhancer: replayEnhancer,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(replay).toMatchObject({ enhanced: 1, descriptionCalls: 0 })
    expect(replayEnhancer.enhance).not.toHaveBeenCalled()
    expect(repository.completions).toHaveLength(2)
  })

  it('does not reuse an R2 generation when the resolved composition prompt changed', async () => {
    const repository = new MemoryEnhancementRepository()
    const store = new MemoryObjectStore()
    repository.enqueue(
      claim('composition-conflict', {
        productDescription: TEST_DESCRIPTION,
        presentationClass: 'pair-upright',
        descriptionModel: 'openai/gpt-5.6-sol',
        describedAt: '2026-07-29T12:00:00.000Z',
        descriptionCostUsd: 0.004,
      }),
    )

    await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store,
        describer: describer(),
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    repository.enqueue(
      claim('composition-conflict', {
        leaseToken: 'lease-composition-conflict-retry',
        productDescription: TEST_DESCRIPTION,
        presentationClass: 'flat-curve',
        descriptionModel: 'openai/gpt-5.6-sol',
        describedAt: '2026-07-29T12:00:00.000Z',
        descriptionCostUsd: 0.004,
      }),
    )
    const replayEnhancer = enhancer()
    const replay = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store,
        describer: describer(),
        enhancer: replayEnhancer,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(replay).toMatchObject({ failed: 1, enhanced: 0 })
    expect(replayEnhancer.enhance).not.toHaveBeenCalled()
    expect(repository.failures.at(-1)).toMatchObject({
      code: 'r2_orphan_generation_conflict',
      retryable: false,
    })
  })

  it('five concurrent workers claim ten rows exactly once', async () => {
    const repository = new MemoryEnhancementRepository()
    for (let index = 1; index <= 10; index += 1) {
      repository.enqueue(
        claim(`concurrent-${index}`, {
          productDescription: TEST_DESCRIPTION,
          presentationClass: 'pair-upright',
          descriptionModel: 'openai/gpt-5.6-sol',
          describedAt: '2026-07-29T12:00:00.000Z',
          descriptionCostUsd: 0.004,
        }),
      )
    }
    const store = new MemoryObjectStore()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runEnhancementBatch({
          drive: drive(),
          repository,
          store,
          describer: describer(),
          enhancer: enhancer(),
          checker: checker(),
          config: CONFIG,
        }),
      ),
    )

    expect(results.reduce((sum, result) => sum + result.enhanced, 0)).toBe(10)
    expect(repository.completions).toHaveLength(10)
    expect(new Set(repository.completions.map((row) => row.intakeFileId)).size).toBe(10)
    expect([...store.objects.keys()].filter((key) => key.endsWith('/v1.png'))).toHaveLength(10)
  })

  it('rejects a stale worker before it can write a generated object', async () => {
    const repository = new MemoryEnhancementRepository()
    const item = claim('stale', {
      productDescription: TEST_DESCRIPTION,
      presentationClass: 'pair-upright',
      descriptionModel: 'openai/gpt-5.6-sol',
      describedAt: '2026-07-29T12:00:00.000Z',
      descriptionCostUsd: 0.004,
    })
    repository.enqueue(item)
    const store = new MemoryObjectStore()
    const staleEnhancer: ImageEnhancer = {
      enhance: vi.fn(async () => {
        repository.validLeases.delete(item.leaseToken)
        return {
          image: Buffer.from(generated),
          costUsd: 0.083,
          model: 'openai/gpt-image-2',
          generationId: 'stale-generation',
        }
      }),
    }

    await expect(
      runEnhancementBatch(
        {
          drive: drive(),
          repository,
          store,
          describer: describer(),
          enhancer: staleEnhancer,
          checker: checker(),
          config: CONFIG,
        },
        { maxItems: 1 },
      ),
    ).rejects.toMatchObject({
      code: 'stale_enhancement_worker',
      stage: 'fencing',
    })
    expect(store.objects.has(`versions/${item.id}/v1.png`)).toBe(false)
    expect(repository.completions).toHaveLength(0)
  })

  it('pauses claims visibly on a provider quota refusal without spending the retry budget', async () => {
    const repository = new MemoryEnhancementRepository()
    const first = claim('quota-one')
    const second = claim('quota-two')
    repository.enqueue(first)
    repository.enqueue(second)

    const quotaError = new EnhancementError('insufficient credit to start a request', {
      stage: 'image',
      code: 'image_provider_quota_exhausted',
      retryable: true,
      quota: true,
    })
    const quotaEnhancer: ImageEnhancer & { enhance: ReturnType<typeof vi.fn> } = {
      enhance: vi.fn(async () => {
        throw quotaError
      }),
    }

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: describer(),
        enhancer: quotaEnhancer,
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 2 },
    )

    expect(result.providerQuotaPaused).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.retryScheduled).toBe(0)
    // No photograph failure was recorded and no attempt was completed.
    expect(repository.failures).toHaveLength(0)
    expect(repository.completions).toHaveLength(0)
    expect(repository.quotaPauses).toHaveLength(2)
    expect(repository.quotaPauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intakeFileId: first.id,
          code: 'image_provider_quota_exhausted',
          stage: 'image',
        }),
        expect.objectContaining({
          intakeFileId: second.id,
          code: 'image_provider_quota_exhausted',
          stage: 'image',
        }),
      ]),
    )
    // Claims run concurrently, so a sibling already past the breaker still
    // makes its call — the breaker only spares one that has not reached it.
    // Harmless: a 402 is refused before generation and bills nothing.
    expect(quotaEnhancer.enhance.mock.calls.length).toBeGreaterThan(0)
    // Exactly one audit row for the account-level condition.
    expect(repository.systemEvents).toHaveLength(1)
    expect(repository.systemEvents[0]).toMatchObject({
      event: 'enhancement.paused_provider_quota',
      detail: { code: 'image_provider_quota_exhausted', claims_released: 2 },
    })
  })

  it('uses the same visible provider pause when the descriptor is refused for credits', async () => {
    const repository = new MemoryEnhancementRepository()
    const item = claim('descriptor-quota')
    repository.enqueue(item)
    const quotaDescriber: JewelleryDescriber = {
      describe: vi.fn(async () => {
        throw new EnhancementError('insufficient credit to start a request', {
          stage: 'describe',
          code: 'describe_provider_quota_exhausted',
          retryable: true,
          quota: true,
        })
      }),
    }

    const result = await runEnhancementBatch(
      {
        drive: drive(),
        repository,
        store: new MemoryObjectStore(),
        describer: quotaDescriber,
        enhancer: enhancer(),
        checker: checker(),
        config: CONFIG,
      },
      { maxItems: 1 },
    )

    expect(result).toMatchObject({ providerQuotaPaused: 1, failed: 0, retryScheduled: 0 })
    expect(repository.descriptionFailures).toHaveLength(0)
    expect(repository.quotaPauses[0]).toMatchObject({
      intakeFileId: item.id,
      code: 'describe_provider_quota_exhausted',
      stage: 'describe',
    })
  })
})

describe('D120 render checker', () => {
  function deps(overrides: {
    readonly repository: MemoryEnhancementRepository
    readonly store?: MemoryObjectStore
    readonly enhancerClient?: ReturnType<typeof enhancer>
    readonly checkerClient: ReturnType<typeof checker>
    readonly config?: EnhancementConfig
  }) {
    return {
      drive: drive(),
      repository: overrides.repository,
      store: overrides.store ?? new MemoryObjectStore(),
      describer: describer(),
      enhancer: overrides.enhancerClient ?? enhancer(),
      checker: overrides.checkerClient,
      config: overrides.config ?? { ...CONFIG, checkEnabled: true },
    }
  }

  it('accepts a passing render after exactly one generation and records the verdict', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('check-pass'))
    const store = new MemoryObjectStore()
    const imageClient = enhancer()
    const checkerClient = checker([{ pass: true, failures: [] }])

    const result = await runEnhancementBatch(
      deps({ repository, store, enhancerClient: imageClient, checkerClient }),
      { maxItems: 1 },
    )

    expect(result.enhanced).toBe(1)
    expect(imageClient.enhance).toHaveBeenCalledTimes(1)
    expect(checkerClient.check).toHaveBeenCalledTimes(1)
    const object = store.objects.get('versions/check-pass/v1.png')
    expect(object?.metadata['check-verdict']).toBe('pass')
    expect(object?.metadata['render-attempt']).toBe('1')
    const event = repository.systemEvents.find((row) => row.event === 'enhancement.render_check')
    expect(event?.detail).toMatchObject({ verdict: 'pass', render_attempts: 1 })
  })

  it('retries once with deterministic correction lines when the verdict fails', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('check-retry'))
    const store = new MemoryObjectStore()
    const imageClient = enhancer(0.05)
    const checkerClient = checker([
      { pass: false, failures: [{ code: 'count', detail: 'one stone missing' }] },
      { pass: true, failures: [] },
    ])

    const result = await runEnhancementBatch(
      deps({ repository, store, enhancerClient: imageClient, checkerClient }),
      { maxItems: 1 },
    )

    expect(result.enhanced).toBe(1)
    expect(imageClient.enhance).toHaveBeenCalledTimes(2)
    const retryPrompt = imageClient.enhance.mock.calls[1]?.[2] as string
    expect(retryPrompt).toContain('RENDER CORRECTIONS')
    expect(retryPrompt).toContain('COUNT —')
    // The stored prompt text is the exact bytes of the accepted retry render.
    expect(repository.completions[0]?.promptText).toBe(retryPrompt)
    // Both paid renders are reported, not just the accepted one.
    expect(repository.completions[0]?.costUsd).toBeCloseTo(0.1, 10)
    const object = store.objects.get('versions/check-retry/v1.png')
    expect(object?.metadata['render-attempt']).toBe('2')
    expect(object?.metadata['check-verdict']).toBe('pass')
  })

  it('stops after the attempt budget and records the failing verdict for the operator', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('check-fail-twice'))
    const store = new MemoryObjectStore()
    const imageClient = enhancer()
    const checkerClient = checker([
      { pass: false, failures: [{ code: 'gauge', detail: 'chain too thick' }] },
    ])

    const result = await runEnhancementBatch(
      deps({ repository, store, enhancerClient: imageClient, checkerClient }),
      { maxItems: 1 },
    )

    // The photograph still completes: a failed verdict is operator information,
    // never a lost render.
    expect(result.enhanced).toBe(1)
    expect(imageClient.enhance).toHaveBeenCalledTimes(2)
    expect(checkerClient.check).toHaveBeenCalledTimes(2)
    const object = store.objects.get('versions/check-fail-twice/v1.png')
    expect(object?.metadata['check-verdict']).toBe('fail')
    expect(object?.metadata['check-codes']).toBe('gauge')
    const event = repository.systemEvents.find((row) => row.event === 'enhancement.render_check')
    expect(event?.detail).toMatchObject({ verdict: 'fail', render_attempts: 2 })
  })

  it('fails open when the checker itself errors: the render is accepted unchecked', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('check-error'))
    const store = new MemoryObjectStore()
    const imageClient = enhancer()
    const checkerClient = checker([new Error('checker outage')])

    const result = await runEnhancementBatch(
      deps({ repository, store, enhancerClient: imageClient, checkerClient }),
      { maxItems: 1 },
    )

    expect(result.enhanced).toBe(1)
    expect(imageClient.enhance).toHaveBeenCalledTimes(1)
    const object = store.objects.get('versions/check-error/v1.png')
    expect(object?.metadata['check-verdict']).toBe('skipped')
    const event = repository.systemEvents.find((row) => row.event === 'enhancement.render_check')
    expect(event?.detail).toMatchObject({ verdict: 'skipped' })
    expect((event?.detail as { check_error?: string }).check_error).toContain('checker outage')
  })

  it('makes no check calls when the checker is disabled', async () => {
    const repository = new MemoryEnhancementRepository()
    repository.enqueue(claim('check-disabled'))
    const checkerClient = checker()

    const result = await runEnhancementBatch(
      deps({ repository, checkerClient, config: { ...CONFIG, checkEnabled: false } }),
      { maxItems: 1 },
    )

    expect(result.enhanced).toBe(1)
    expect(checkerClient.check).not.toHaveBeenCalled()
    expect(
      repository.systemEvents.some((row) => row.event === 'enhancement.render_check'),
    ).toBe(false)
  })
})
