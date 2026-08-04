import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { EnhancementConfig } from '@/lib/enhance/config'
import { EnhancementError } from '@/lib/enhance/errors'
import type {
  ImageEnhancer,
  JewelleryDescriber,
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
        config: { ...CONFIG, injectDescription: false },
      },
      { maxItems: 1 },
    )

    expect(result.descriptionCalls).toBe(0)
    expect(descriptionClient.describe).not.toHaveBeenCalled()
    expect(repository.storedDescriptions).toHaveLength(0)
    expect(repository.completions[0]?.promptText).toContain(
      'Show the exact source pieces upright and front-facing',
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
})
