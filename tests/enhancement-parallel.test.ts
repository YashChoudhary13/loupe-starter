import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { EnhancementConfig } from '@/lib/enhance/config'
import {
  sweepFailedFilesOutOfRaw,
  terminalFailures,
} from '@/lib/enhance/failed-housekeeping'
import type { ImageEnhancer, JewelleryDescriber, RenderChecker } from '@/lib/enhance/openrouter'
import { runEnhancementBatch, type EnhancementOutcome } from '@/lib/enhance/worker'

import { claim, MemoryEnhancementRepository, MemoryObjectStore, TEST_DESCRIPTION } from './helpers/enhancement'

const CONFIG: EnhancementConfig = {
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

let source: Buffer
let generated: Buffer

beforeAll(async () => {
  source = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#c9a227' },
  })
    .jpeg()
    .toBuffer()
  generated = await sharp({
    create: { width: 1280, height: 1280, channels: 3, background: '#f6efe6' },
  })
    .png()
    .toBuffer()
})

function passChecker(): RenderChecker {
  return {
    check: vi.fn(async () => ({
      verdict: { pass: true, failures: [] },
      costUsd: 0.006,
      model: 'google/gemini-3.6-flash',
      requestId: 'check-1',
    })),
  }
}

function drive() {
  return { downloadFile: vi.fn(async () => Buffer.from(source)) }
}

function describer(): JewelleryDescriber {
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

/**
 * An enhancer that records when each call is in flight, so overlap is
 * observable rather than assumed. Every call waits for the same release, which
 * a sequential worker could never satisfy — item 2 would not start until item 1
 * finished, and item 1 never finishes.
 */
function gatedEnhancer(expected: number) {
  let started = 0
  let release: () => void = () => {}
  const allStarted = new Promise<void>((resolve) => {
    release = resolve
  })
  const enhance = vi.fn(async () => {
    started += 1
    if (started >= expected) release()
    await allStarted
    return {
      image: Buffer.from(generated),
      costUsd: 0.08,
      model: 'openai/gpt-image-2',
      generationId: `generation-${started}`,
    }
  })
  return { enhancer: { enhance } as ImageEnhancer, peak: () => started }
}

describe('four photographs per tick, in parallel', () => {
  it('runs all four image calls at the same time', async () => {
    const repository = new MemoryEnhancementRepository()
    for (const id of ['a', 'b', 'c', 'd']) repository.enqueue(claim(id))
    const { enhancer, peak } = gatedEnhancer(4)

    // Deadlocks and fails if the worker is sequential: the first call blocks
    // until four calls are in flight, and a sequential worker never starts the
    // second. Nothing here waits on a timer, so it cannot pass by luck.
    const result = await runEnhancementBatch({
      drive: drive(),
      repository,
      store: new MemoryObjectStore(),
      describer: describer(),
      enhancer,
      checker: passChecker(),
      config: CONFIG,
    })

    expect(peak()).toBe(4)
    expect(result.claimed).toBe(4)
    expect(result.enhanced).toBe(4)
  })

  it('claims no more than four, so one tick cannot drain an unbounded queue', async () => {
    const repository = new MemoryEnhancementRepository()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) repository.enqueue(claim(id))
    const { enhancer } = gatedEnhancer(4)

    const result = await runEnhancementBatch({
      drive: drive(),
      repository,
      store: new MemoryObjectStore(),
      describer: describer(),
      enhancer,
      checker: passChecker(),
      config: CONFIG,
    })

    expect(result.claimed).toBe(4)
  })

  it('keeps the siblings’ results when one claim loses its lease mid-flight', async () => {
    const repository = new MemoryEnhancementRepository()
    for (const id of ['keeps-1', 'loses-lease', 'keeps-2']) repository.enqueue(claim(id))
    // The replacement worker owns this row now. processClaim rethrows rather
    // than writing, and that must not discard the other two finished rows.
    repository.validLeases.delete('lease-loses-lease')
    // Only two reach the image call — the third is rejected at its first
    // lease check, long before anything is paid for.
    const { enhancer } = gatedEnhancer(2)

    const result = await runEnhancementBatch({
      drive: drive(),
      repository,
      store: new MemoryObjectStore(),
      describer: describer(),
      enhancer,
      checker: passChecker(),
      config: CONFIG,
    })

    expect(result.claimed).toBe(3)
    expect(result.stale).toBe(1)
    expect(result.outcomes).toHaveLength(2)
    expect(result.outcomes.map((row) => row.intakeFileId).sort()).toEqual(['keeps-1', 'keeps-2'])
  })
})

function outcome(
  intakeFileId: string,
  status: EnhancementOutcome['status'],
): EnhancementOutcome {
  return {
    intakeFileId,
    driveFileId: `drive-${intakeFileId}`,
    status,
    attempts: 5,
    descriptionCalled: true,
    descriptionInjected: true,
    descriptionMissing: false,
  }
}

describe('sweeping finished failures out of Drive /Raw', () => {
  it('moves only work that has finished failing', () => {
    expect(
      terminalFailures([
        outcome('done', 'enhanced'),
        outcome('coming-back', 'retry_scheduled'),
        outcome('spent', 'failed'),
        outcome('too-expensive', 'cost_ceiling_failed'),
      ]).map((row) => row.intakeFileId),
    ).toEqual(['spent', 'too-expensive'])
  })

  it('never moves a photograph that is still queued for another attempt', async () => {
    // The whole point: a retry is coming, and a file in /Discarded would tell
    // whoever is watching the folder that Loupe had given up on it.
    const drive = { moveToFolder: vi.fn() }
    const db = { rpc: vi.fn(async () => ({ error: null })) }
    await sweepFailedFilesOutOfRaw([outcome('coming-back', 'retry_scheduled')], {
      db: db as never,
      drive,
      discardedFolderId: 'discarded-folder',
      actor: 'test',
    })
    expect(drive.moveToFolder).not.toHaveBeenCalled()
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('moves each failure to the discarded folder and records it', async () => {
    const drive = {
      moveToFolder: vi.fn(async (fileId: string) => ({ fileId, moved: true, parents: ['discarded-folder'] })),
    }
    const db = { rpc: vi.fn(async () => ({ error: null })) }

    const swept = await sweepFailedFilesOutOfRaw([outcome('spent', 'failed')], {
      db: db as never,
      drive,
      discardedFolderId: 'discarded-folder',
      actor: 'cron:enhance',
    })

    expect(drive.moveToFolder).toHaveBeenCalledWith('drive-spent', 'discarded-folder')
    expect(db.rpc).toHaveBeenCalledWith('record_drive_housekeeping', {
      p_intake_file_id: 'spent',
      p_ok: true,
      p_error: null,
      p_actor: 'cron:enhance',
    })
    expect(swept[0]).toMatchObject({ ok: true, moved: true })
  })

  it('carries on when one move fails, and records the reason', async () => {
    const drive = {
      moveToFolder: vi.fn(async (fileId: string) => {
        if (fileId === 'drive-stuck') throw new Error('Drive said no')
        return { fileId, moved: true, parents: ['discarded-folder'] }
      }),
    }
    const db = { rpc: vi.fn(async () => ({ error: null })) }

    const swept = await sweepFailedFilesOutOfRaw(
      [outcome('stuck', 'failed'), outcome('fine', 'failed')],
      { db: db as never, drive, discardedFolderId: 'discarded-folder', actor: 'test' },
    )

    // A file stuck in /Raw is untidy, not incorrect — the row is already failed
    // and already visible in Tracking.
    expect(swept.map((row) => row.ok)).toEqual([false, true])
    expect(swept[0]?.error).toBe('Drive said no')
    expect(db.rpc).toHaveBeenCalledWith(
      'record_drive_housekeeping',
      expect.objectContaining({ p_ok: false, p_error: 'Drive said no' }),
    )
  })
})
