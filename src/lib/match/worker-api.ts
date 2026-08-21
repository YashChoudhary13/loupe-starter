import type { SupabaseClient } from '@supabase/supabase-js'

import {
  CANDIDATE_COUNT,
  EMBEDDING_DIM,
  type Candidate,
  type ClaimedJob,
  type EmbedResult,
  type IdentifyResult,
  type MatchJobKind,
  type SyncResult,
  type WorkerFailure,
} from './types'

/**
 * The worker API, behind /api/worker/*.
 *
 * Deliberately NOT `server-only` and deliberately taking its dependencies by
 * injection (the shape of the enhancement worker and the retention purge): the
 * fencing and the candidate shaping must be provable without a database.
 *
 * Ownership (D111): the worker embeds; Loupe decides what that means. A finished
 * identify job becomes ten candidates HERE, via match_search(), and is recorded
 * on the event by record_match_candidates(). The worker never sees the index.
 */

export interface WorkerApiDeps {
  readonly db: Pick<SupabaseClient, 'rpc'>
  /** Presigned GET for an R2 key. */
  readonly presign: (key: string, ttlSeconds: number) => Promise<string>
  /** Public origin of this deployment, for /api/worker/source links. */
  readonly baseUrl: string
  /** Writes a small object (the query preview). Optional: tests omit it. */
  readonly putObject?: (key: string, bytes: Buffer, contentType: string) => Promise<void>
  readonly now?: () => Date
}

export class WorkerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WorkerApiError'
  }
}

const SOURCE_URL_TTL_SECONDS = 60 * 60
const JOB_KINDS: readonly MatchJobKind[] = ['sync', 'embed', 'identify']

interface ClaimRow {
  job_id: string
  kind: MatchJobKind
  lease_token: string
  lease_expires_at: string
  attempts: number
  reference_id: string | null
  ref_sku: string | null
  ref_handle: string | null
  ref_storage_key: string | null
  ref_image_url: string | null
  ref_local_path: string | null
  ref_sha256: string | null
  match_event_id: string | null
  event_query_key: string | null
  event_surface: string | null
}

function rpcError(fn: string, error: { message: string; code?: string; hint?: string }): WorkerApiError {
  // 55000 is the lease fence in complete_match_job / fail_match_job.
  if (error.code === '55000') return new WorkerApiError(error.hint ?? error.message, 409)
  if (error.code === '22023') return new WorkerApiError(error.message, 400)
  return new WorkerApiError(`${fn}: ${error.message}`, 500)
}

export function isJobKind(value: unknown): value is MatchJobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value)
}

export async function heartbeat(
  input: { workerId: string; device: string; kinds: readonly string[]; version: string },
  deps: WorkerApiDeps,
): Promise<void> {
  const { error } = await deps.db.rpc('worker_heartbeat', {
    p_worker: input.workerId,
    p_device: input.device,
    p_kinds: input.kinds,
    p_version: input.version,
  })
  if (error) throw rpcError('worker_heartbeat', error)
}

export async function claimJob(
  input: { workerId: string; kinds: readonly MatchJobKind[]; leaseSeconds?: number },
  deps: WorkerApiDeps,
): Promise<ClaimedJob | null> {
  if (!input.workerId.trim()) throw new WorkerApiError('worker_id is required', 400)
  if (input.kinds.length === 0 || !input.kinds.every(isJobKind)) {
    throw new WorkerApiError('kinds must be a non-empty list of sync, embed, identify', 400)
  }
  const { data, error } = await deps.db.rpc('claim_match_job', {
    p_worker: input.workerId,
    p_kinds: input.kinds,
    p_lease_seconds: input.leaseSeconds ?? 600,
  })
  if (error) throw rpcError('claim_match_job', error)
  const row = ((data ?? []) as ClaimRow[])[0]
  if (!row) return null

  const job: ClaimedJob = {
    id: row.job_id,
    kind: row.kind,
    lease_token: row.lease_token,
    lease_expires_at: row.lease_expires_at,
    attempts: row.attempts,
  }

  if (row.reference_id) {
    const key = row.ref_storage_key
    const source_url = key ? await deps.presign(key, SOURCE_URL_TTL_SECONDS) : row.ref_image_url
    if (!source_url) throw new WorkerApiError(`reference ${row.reference_id} has no bytes`, 500)
    const filename = (key ?? row.ref_image_url ?? '').split('?')[0]!.split('/').pop() || `${row.reference_id}.jpg`
    return {
      ...job,
      reference: {
        id: row.reference_id,
        sku: row.ref_sku ?? '',
        handle: row.ref_handle,
        sha256: row.ref_sha256,
        local_path: row.ref_local_path,
        source_url,
        filename,
      },
    }
  }

  if (row.match_event_id) {
    const key = row.event_query_key ?? ''
    const source_url = key.startsWith('drive:')
      ? `${deps.baseUrl.replace(/\/+$/, '')}/api/worker/source/${row.job_id}?token=${row.lease_token}`
      : await deps.presign(key, SOURCE_URL_TTL_SECONDS)
    return {
      ...job,
      event: { id: row.match_event_id, surface: row.event_surface ?? 'upload', source_url },
    }
  }

  throw new WorkerApiError(`job ${row.job_id} has no subject`, 500)
}

function vectorLiteral(values: readonly number[], label: string): string {
  if (values.length !== EMBEDDING_DIM) {
    throw new WorkerApiError(`${label} must have ${EMBEDDING_DIM} values, got ${values.length}`, 400)
  }
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new WorkerApiError(`${label} contains a non-finite value`, 400)
  }
  return `[${values.map((v) => v.toFixed(7)).join(',')}]`
}

export async function completeJob(
  input: {
    jobId: string
    leaseToken: string
    kind: MatchJobKind
    result?: SyncResult | EmbedResult | IdentifyResult
    error?: WorkerFailure
  },
  deps: WorkerApiDeps,
): Promise<{ candidates?: readonly Candidate[] }> {
  if (input.error) {
    const { error } = await deps.db.rpc('fail_match_job', {
      p_job: input.jobId,
      p_token: input.leaseToken,
      p_error: input.error.message,
      p_retryable: input.error.retryable,
    })
    if (error) throw rpcError('fail_match_job', error)
    return {}
  }
  if (!input.result) throw new WorkerApiError('result or error is required', 400)

  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)

  if (input.kind === 'sync') {
    const { error } = await deps.db.rpc('complete_match_job', {
      p_job: input.jobId,
      p_token: input.leaseToken,
      p_result: input.result,
    })
    if (error) throw rpcError('complete_match_job', error)
    return {}
  }

  if (input.kind === 'embed') {
    const result = input.result as EmbedResult
    const full = vectorLiteral(result.embeddings?.full ?? [], 'embeddings.full')
    const crop = vectorLiteral(result.embeddings?.crop ?? [], 'embeddings.crop')
    // The reference id is not in the request on purpose: the job row knows it,
    // and the store happens only after the fence below passes. So read it back
    // through the fenced completion: store first under the job's reference.
    const { data: job, error: jobError } = await deps.db.rpc('match_job_reference', {
      p_job: input.jobId,
      p_token: input.leaseToken,
    })
    if (jobError) throw rpcError('match_job_reference', jobError)
    const referenceId = job as string | null
    if (!referenceId) throw new WorkerApiError('lease lost or job has no reference', 409)
    for (const [view, literal] of [['full', full], ['crop', crop]] as const) {
      const { error } = await deps.db.rpc('store_match_embedding', {
        p_reference: referenceId,
        p_view: view,
        p_embedding: literal,
        p_model: result.model,
      })
      if (error) throw rpcError('store_match_embedding', error)
    }
    const { error } = await deps.db.rpc('complete_match_job', {
      p_job: input.jobId,
      p_token: input.leaseToken,
      p_result: { index_version: today, crop_box: result.crop_box ?? null },
    })
    if (error) throw rpcError('complete_match_job', error)
    return {}
  }

  // identify
  const result = input.result as IdentifyResult
  const literal = vectorLiteral(result.embedding ?? [], 'embedding')
  const { data: eventId, error: eventError } = await deps.db.rpc('match_job_event', {
    p_job: input.jobId,
    p_token: input.leaseToken,
  })
  if (eventError) throw rpcError('match_job_event', eventError)
  if (!eventId) throw new WorkerApiError('lease lost or job has no event', 409)

  const { data: rows, error: searchError } = await deps.db.rpc('match_search', {
    p_embedding: literal,
    p_limit: CANDIDATE_COUNT,
  })
  if (searchError) throw rpcError('match_search', searchError)
  const candidates: Candidate[] = ((rows ?? []) as { sku: string; handle: string | null; score: number }[])
    .slice(0, CANDIDATE_COUNT)
    .map((r, i) => ({ rank: i + 1, sku: r.sku, handle: r.handle, score: Number(r.score) }))

  // The worker's preview of the query: the only image Loupe ever has of a
  // Drive photograph before enhancement. Best effort; never blocks the match.
  if (result.thumbnail_webp_base64 && deps.putObject) {
    try {
      const bytes = Buffer.from(result.thumbnail_webp_base64, 'base64')
      if (bytes.byteLength > 0 && bytes.byteLength <= 64 * 1024) {
        const thumbKey = `identify/thumbs/${eventId}.webp`
        await deps.putObject(thumbKey, bytes, 'image/webp')
        await deps.db.rpc('record_match_thumb', { p_job: input.jobId, p_token: input.leaseToken, p_thumb_key: thumbKey })
      }
    } catch (cause) {
      console.error('query thumbnail not stored:', cause instanceof Error ? cause.message : cause)
    }
  }

  const { error: recordError } = await deps.db.rpc('record_match_candidates', {
    p_event: eventId,
    p_candidates: candidates,
    p_model: result.model,
    p_index_version: today,
    p_crop_box: result.crop_box ?? null,
    p_latency_ms: Math.round(result.timing_ms?.total ?? 0) || null,
  })
  if (recordError) throw rpcError('record_match_candidates', recordError)

  const { error } = await deps.db.rpc('complete_match_job', {
    p_job: input.jobId,
    p_token: input.leaseToken,
    p_result: { candidates: candidates.length },
  })
  if (error) throw rpcError('complete_match_job', error)
  return { candidates }
}
