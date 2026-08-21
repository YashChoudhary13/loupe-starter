import { describe, expect, it } from 'vitest'

import { claimJob, completeJob, WorkerApiError, type WorkerApiDeps } from '@/lib/match/worker-api'

/** D111: what the worker is handed, and how its results become Loupe's rows. No database. */

function fakeDeps(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const deps: WorkerApiDeps = {
    db: {
      rpc: (async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args })
        const handler = handlers[fn]
        if (!handler) return { data: null, error: { message: `no handler for ${fn}` } }
        try {
          return { data: await handler(args), error: null }
        } catch (cause) {
          return { data: null, error: cause as { message: string; code?: string } }
        }
      }) as unknown as WorkerApiDeps['db']['rpc'],
    },
    presign: async (key, ttl) => `https://r2.test/${key}?ttl=${ttl}`,
    baseUrl: 'https://loupe.test/',
    now: () => new Date('2026-08-22T00:00:00Z'),
  }
  return { deps, calls }
}

const unit = (i: number) => Array.from({ length: 1152 }, (_, k) => (k === i ? 1 : 0))

describe('claimJob', () => {
  it('hands a sync job a presigned URL for its R2 key and a filename', async () => {
    const { deps } = fakeDeps({
      claim_match_job: () => [{
        job_id: 'job-1', kind: 'sync', lease_token: 'tok', lease_expires_at: '2026-08-22T00:10:00Z', attempts: 1,
        reference_id: 'ref-1', ref_sku: 'NK845', ref_handle: 'necklace-845', ref_storage_key: 'references/NK845/ref-1.jpg',
        ref_image_url: null, ref_local_path: null, ref_sha256: 'abc', match_event_id: null, event_query_key: null, event_surface: null,
      }],
    })
    const job = await claimJob({ workerId: 'laptop', kinds: ['sync', 'embed'] }, deps)
    expect(job).toMatchObject({
      id: 'job-1', kind: 'sync', lease_token: 'tok',
      reference: { id: 'ref-1', sku: 'NK845', filename: 'ref-1.jpg', source_url: 'https://r2.test/references/NK845/ref-1.jpg?ttl=3600' },
    })
  })

  it('routes a Drive photograph through /api/worker/source with the lease token, never a Drive credential', async () => {
    const { deps } = fakeDeps({
      claim_match_job: () => [{
        job_id: 'job-2', kind: 'identify', lease_token: 'tok-2', lease_expires_at: 'x', attempts: 1,
        reference_id: null, ref_sku: null, ref_handle: null, ref_storage_key: null, ref_image_url: null, ref_local_path: null, ref_sha256: null,
        match_event_id: 'evt-1', event_query_key: 'drive:1AbC', event_surface: 'drive',
      }],
    })
    const job = await claimJob({ workerId: 'laptop', kinds: ['identify'] }, deps)
    expect(job?.event).toEqual({ id: 'evt-1', surface: 'drive', source_url: 'https://loupe.test/api/worker/source/job-2?token=tok-2' })
  })

  it('returns null when the queue is empty and refuses unknown kinds', async () => {
    const { deps } = fakeDeps({ claim_match_job: () => [] })
    expect(await claimJob({ workerId: 'laptop', kinds: ['sync'] }, deps)).toBeNull()
    await expect(claimJob({ workerId: 'laptop', kinds: ['delete' as never] }, deps)).rejects.toBeInstanceOf(WorkerApiError)
  })
})

describe('completeJob', () => {
  it('turns an identify embedding into ten ranked candidates and records them before completing', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ sku: `SK${i}`, handle: `sk-${i}`, score: 1 - i / 100 }))
    const { deps, calls } = fakeDeps({
      match_job_event: () => 'evt-1',
      match_search: () => rows,
      record_match_candidates: () => null,
      complete_match_job: () => null,
    })
    const outcome = await completeJob(
      { jobId: 'job-2', leaseToken: 'tok', kind: 'identify', result: { embedding: unit(0), model: 'siglip2', timing_ms: { total: 1234.6 } } },
      deps,
    )
    expect(outcome.candidates).toHaveLength(10)
    expect(outcome.candidates![0]).toEqual({ rank: 1, sku: 'SK0', handle: 'sk-0', score: 1 })
    expect(outcome.candidates![9]!.rank).toBe(10)
    expect(calls.map((c) => c.fn)).toEqual(['match_job_event', 'match_search', 'record_match_candidates', 'complete_match_job'])
    expect(calls[2]!.args.p_latency_ms).toBe(1235)
    expect(String(calls[1]!.args.p_embedding)).toMatch(/^\[1\.0000000,0\.0000000,/)
  })

  it('stores both views under the job\'s reference, then completes the embed job', async () => {
    const { deps, calls } = fakeDeps({
      match_job_reference: () => 'ref-1',
      store_match_embedding: () => null,
      complete_match_job: () => null,
    })
    await completeJob(
      { jobId: 'job-3', leaseToken: 'tok', kind: 'embed', result: { embeddings: { full: unit(1), crop: unit(2) }, model: 'siglip2' } },
      deps,
    )
    expect(calls.map((c) => c.fn)).toEqual(['match_job_reference', 'store_match_embedding', 'store_match_embedding', 'complete_match_job'])
    expect(calls[1]!.args).toMatchObject({ p_reference: 'ref-1', p_view: 'full' })
    expect(calls[3]!.args.p_result).toEqual({ index_version: '2026-08-22', crop_box: null })
  })

  it('refuses a vector of the wrong length before touching the database', async () => {
    const { deps, calls } = fakeDeps({})
    await expect(
      completeJob({ jobId: 'j', leaseToken: 't', kind: 'identify', result: { embedding: [1, 2, 3], model: 'm' } }, deps),
    ).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(0)
  })

  it('maps a lost lease to 409 and reports failures through fail_match_job', async () => {
    const { deps, calls } = fakeDeps({
      fail_match_job: () => { throw { message: 'lease lost', code: '55000', hint: 'Reclaimed.' } },
    })
    await expect(
      completeJob({ jobId: 'j', leaseToken: 't', kind: 'sync', error: { message: 'disk full', retryable: true } }, deps),
    ).rejects.toMatchObject({ status: 409, message: 'Reclaimed.' })
    expect(calls[0]!.args).toMatchObject({ p_error: 'disk full', p_retryable: true })
  })
})
