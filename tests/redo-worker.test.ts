import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import type { EnhancementConfig } from '@/lib/enhance/config'
import type { ImageEnhancer } from '@/lib/enhance/openrouter'
import type {
  RedoClaim,
  RedoCompletion,
  RedoFailure,
  RedoRepository,
} from '@/lib/enhance/redo-repository'
import { runRedoBatch } from '@/lib/enhance/redo-worker'
import { sha256 } from '@/lib/enhance/storage'

import { MemoryObjectStore } from './helpers/enhancement'

const config: EnhancementConfig = {
  describeModel: 'openai/gpt-5.6-sol',
  describeReasoningEffort: 'minimal',
  injectDescription: true,
  imageModel: 'openai/gpt-image-2',
  imageSize: '1280x1280',
  imageQuality: 'medium',
  maxCostUsdPerImage: 0.2,
  maxCostUsdPerDescription: 0.02,
  checkEnabled: false,
  checkModel: 'google/gemini-3.6-flash',
  maxCostUsdPerCheck: 0.02,
  maxRenderAttempts: 2,
}

function redoClaim(overrides: Partial<RedoClaim> = {}): RedoClaim {
  return {
    id: 'redo-job-1',
    intakeFileId: 'intake-1',
    sourceVersionId: 'original-version-1',
    sourceStorageKey: 'originals/intake-1.png',
    versionNo: 2,
    promptId: 'prompt-image',
    promptText: 'Resolved prompt with cached description and composition.',
    model: 'openai/gpt-image-2',
    descriptionInjected: true,
    descriptionMissing: false,
    attempts: 0,
    leaseToken: 'redo-lease-1',
    leaseExpiresAt: '2026-07-30T15:00:00.000Z',
    generationStartedAt: null,
    ...overrides,
  }
}

class MemoryRedoRepository implements RedoRepository {
  readonly claims: RedoClaim[] = []
  readonly completions: Parameters<RedoRepository['complete']>[0][] = []
  readonly failures: Parameters<RedoRepository['recordFailure']>[0][] = []
  readonly generationStarts: string[] = []
  readonly validLeases = new Set<string>()

  add(claim: RedoClaim) {
    this.claims.push(claim)
    this.validLeases.add(claim.leaseToken)
  }

  async enqueue(): Promise<string> {
    return 'redo-job-1'
  }

  async claim(): Promise<RedoClaim | null> {
    return this.claims.shift() ?? null
  }

  async assertLease(_jobId: string, leaseToken: string): Promise<boolean> {
    return this.validLeases.has(leaseToken)
  }

  async markGenerationStarted(jobId: string, leaseToken: string): Promise<string> {
    if (!this.validLeases.has(leaseToken)) throw new Error('stale')
    this.generationStarts.push(jobId)
    return '2026-07-30T12:00:00.000Z'
  }

  async complete(
    input: Parameters<RedoRepository['complete']>[0],
  ): Promise<RedoCompletion> {
    this.completions.push(input)
    this.validLeases.delete(input.leaseToken)
    return {
      status: input.costUsd > input.maxCostUsd ? 'failed' : 'completed',
      imageVersionId: 'version-2',
      versionNo: 2,
      costUsd: input.costUsd,
    }
  }

  async recordFailure(
    input: Parameters<RedoRepository['recordFailure']>[0],
  ): Promise<RedoFailure> {
    this.failures.push(input)
    this.validLeases.delete(input.leaseToken)
    return {
      status: input.retryable ? 'queued' : 'failed',
      attempts: 1,
      nextAttemptAt: '2026-07-30T12:01:00.000Z',
    }
  }
}

async function sourceImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: '#d8b56b',
    },
  })
    .png()
    .toBuffer()
}

async function generatedImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: '#f4ead8',
    },
  })
    .png()
    .toBuffer()
}

function enhancer(image: Buffer): ImageEnhancer & {
  enhance: ReturnType<typeof vi.fn>
} {
  return {
    enhance: vi.fn(async () => ({
      image,
      costUsd: 0.073376,
      model: 'openai/gpt-image-2',
      generationId: 'generation-1',
    })),
  }
}

describe('image redo worker', () => {
  it('makes one image call, reuses the resolved prompt and appends version 2', async () => {
    const repository = new MemoryRedoRepository()
    const store = new MemoryObjectStore()
    const claim = redoClaim()
    const source = await sourceImage()
    const generated = await generatedImage()
    repository.add(claim)
    await store.putImmutable(claim.sourceStorageKey, source, 'image/png')
    const imageClient = enhancer(generated)

    const result = await runRedoBatch({
      repository,
      store,
      enhancer: imageClient,
      config,
    })

    expect(result).toMatchObject({
      completed: 1,
      paidCalls: 1,
      recovered: 0,
      versionNo: 2,
      costUsd: 0.073376,
    })
    expect(imageClient.enhance).toHaveBeenCalledTimes(1)
    expect(imageClient.enhance.mock.calls[0]?.[2]).toBe(claim.promptText)
    expect(imageClient.enhance.mock.calls[0]?.[3]).toMatchObject({
      model: claim.model,
      size: '1280x1280',
      quality: 'medium',
    })
    expect(repository.generationStarts).toEqual([claim.id])
    expect(repository.completions[0]).toMatchObject({
      storageKey: 'versions/intake-1/v2.png',
      thumbKey: 'versions/intake-1/v2_thumb.webp',
      actualModel: 'openai/gpt-image-2',
      costUsd: 0.073376,
    })
  })

  it('recovers a durable generated object after a crash without a second paid call', async () => {
    const repository = new MemoryRedoRepository()
    const store = new MemoryObjectStore()
    const claim = redoClaim({ generationStartedAt: '2026-07-30T12:00:00.000Z' })
    const source = await sourceImage()
    const generated = await generatedImage()
    repository.add(claim)
    await store.putImmutable(claim.sourceStorageKey, source, 'image/png')
    await store.putImmutable(
      'versions/intake-1/v2.png',
      generated,
      'image/png',
      {
        'redo-job-id': claim.id,
        'intake-id': claim.intakeFileId,
        'version-no': '2',
        'source-sha256': sha256(source),
        'prompt-sha256': sha256(claim.promptText),
        'requested-model': claim.model,
        'image-size': '1280x1280',
        'image-quality': 'medium',
        'description-injected': 'true',
        'description-missing': 'false',
        model: claim.model,
        'cost-usd': '0.073376',
        width: '1280',
        height: '1280',
      },
    )
    const imageClient = enhancer(generated)

    const result = await runRedoBatch({
      repository,
      store,
      enhancer: imageClient,
      config,
    })

    expect(result).toMatchObject({ completed: 1, paidCalls: 0, recovered: 1 })
    expect(imageClient.enhance).not.toHaveBeenCalled()
    expect(repository.completions).toHaveLength(1)
  })

  it('refuses an automatic second paid call when a crashed request left no object', async () => {
    const repository = new MemoryRedoRepository()
    const store = new MemoryObjectStore()
    const claim = redoClaim({ generationStartedAt: '2026-07-30T12:00:00.000Z' })
    repository.add(claim)
    await store.putImmutable(claim.sourceStorageKey, await sourceImage(), 'image/png')
    const imageClient = enhancer(await generatedImage())

    const result = await runRedoBatch({
      repository,
      store,
      enhancer: imageClient,
      config,
    })

    expect(result).toMatchObject({ failed: 1, paidCalls: 0, recovered: 0 })
    expect(imageClient.enhance).not.toHaveBeenCalled()
    expect(repository.failures[0]).toMatchObject({
      code: 'redo_generation_outcome_unknown',
      retryable: false,
    })
  })
})
