import 'server-only'

import { randomUUID } from 'node:crypto'

import type { Operator } from '@/lib/auth/authorize'
import { consoleObjectStore } from '@/lib/console/images'
import { ConsoleError } from '@/lib/console/mutations'
import { supabaseServer } from '@/lib/supabase/server'

import { parseJobLabel, type JobStatus } from './label'

/**
 * D143: Enhance jobs. Operator side: a job collects phone photographs under
 * `intake/<job>/<photo>.<ext>` and is queued. Enhancer side (bearer AGENT_SECRET):
 * claim, heartbeat, finish. The finals come back through /api/agent/images with the
 * job label as `batch` (D142).
 */

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' } as const
type PhotoMime = keyof typeof EXTENSIONS
export const JOB_PHOTO_MAX_BYTES = 50_000_000
const PUT_TTL_SECONDS = 15 * 60
const GET_TTL_SECONDS = 20 * 60

export interface JobSummary {
  readonly id: string
  readonly label: string
  readonly status: JobStatus
  readonly createdAt: string
  readonly queuedAt: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly runner: string | null
  readonly note: string | null
  readonly error: string | null
  readonly photoCount: number
  readonly resultCount: number
}

interface JobRow {
  id: string; label: string; status: JobStatus; created_at: string; queued_at: string | null; started_at: string | null
  finished_at: string | null; runner: string | null; note: string | null; error: string | null; photo_count: number; result_count: number
}
const JOB_COLUMNS = 'id, label, status, created_at, queued_at, started_at, finished_at, runner, note, error, photo_count, result_count'

function summary(r: JobRow): JobSummary {
  return {
    id: r.id, label: r.label, status: r.status, createdAt: r.created_at, queuedAt: r.queued_at, startedAt: r.started_at,
    finishedAt: r.finished_at, runner: r.runner, note: r.note, error: r.error, photoCount: r.photo_count, resultCount: r.result_count,
  }
}

function rpcError(message: string, error: { code?: string; message: string; hint?: string | null }): ConsoleError {
  const hint = error.hint?.trim()
  return new ConsoleError(hint || message, [error.code, error.message].filter(Boolean).join(' · '), error.code !== '55000' && error.code !== '22023')
}

export async function createJob(operator: Operator, rawLabel: unknown): Promise<JobSummary> {
  const label = parseJobLabel(rawLabel)
  const { data, error } = await supabaseServer()
    .from('agent_jobs').insert({ label, created_by: operator.email }).select(JOB_COLUMNS).single<JobRow>()
  if (error) {
    if (error.code === '23505') throw new ConsoleError(`A batch called "${label}" already exists. Pick another label.`, null, false)
    throw new ConsoleError('The batch could not be created.', error.message, true)
  }
  return summary(data)
}

export async function beginJobPhotoUpload(
  _operator: Operator,
  input: { jobId: string; filename: string; mimeType: string; bytes: number },
): Promise<{ photoId: string; uploadUrl: string; contentType: PhotoMime }> {
  const filename = input.filename.trim()
  if (!filename || filename.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(filename)) throw new ConsoleError('That filename cannot be used.', null, false)
  if (!(input.mimeType in EXTENSIONS)) throw new ConsoleError('Photos must be JPEG, PNG, WebP or HEIC.', `Received ${input.mimeType || '(missing)'}`, false)
  const mime = input.mimeType as PhotoMime
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > JOB_PHOTO_MAX_BYTES) throw new ConsoleError('That photo is empty or larger than 50 MB.', null, false)
  const db = supabaseServer()
  const { data: job, error: jobError } = await db.from('agent_jobs').select('status').eq('id', input.jobId).maybeSingle<{ status: JobStatus }>()
  if (jobError || !job) throw new ConsoleError('That batch no longer exists.', jobError?.message ?? null, false)
  if (job.status !== 'collecting') throw new ConsoleError(`That batch is already ${job.status}; start a new one.`, null, false)
  const photoId = randomUUID()
  const key = `intake/${input.jobId}/${photoId}.${EXTENSIONS[mime]}`
  const { error } = await db.from('agent_job_photos').insert({ id: photoId, job_id: input.jobId, storage_key: key, filename, bytes: input.bytes })
  if (error) throw new ConsoleError('The photo upload could not be started.', error.message, true)
  const uploadUrl = await consoleObjectStore().presignPut(key, mime, PUT_TTL_SECONDS)
  return { photoId, uploadUrl, contentType: mime }
}

export async function finishJobPhotoUpload(_operator: Operator, photoId: string): Promise<{ photoCount: number }> {
  const db = supabaseServer()
  const { data: photo, error } = await db.from('agent_job_photos').select('storage_key, status').eq('id', photoId).maybeSingle<{ storage_key: string; status: string }>()
  if (error || !photo) throw new ConsoleError('That photo upload was not found.', error?.message ?? null, false)
  const head = await consoleObjectStore().head(photo.storage_key)
  if (!head) throw new ConsoleError('The photo never reached storage. Try it again.', photo.storage_key, true)
  // ponytail: no decode here; the enhancer reads the file itself. Width/height stay null.
  const { data, error: rpcErr } = await db.rpc('agent_job_photo_uploaded', { p_photo_id: photoId, p_bytes: head.bytes })
  if (rpcErr) throw rpcError('The photo could not be recorded.', rpcErr)
  return { photoCount: typeof data === 'number' ? data : 0 }
}

export async function queueJob(operator: Operator, jobId: string): Promise<void> {
  const { error } = await supabaseServer().rpc('agent_job_queue', { p_job_id: jobId, p_actor: operator.email })
  if (error) throw rpcError('The batch could not be sent.', error)
}

export async function listJobs(limit = 30): Promise<readonly JobSummary[]> {
  const { data, error } = await supabaseServer().from('agent_jobs').select(JOB_COLUMNS).order('created_at', { ascending: false }).limit(limit)
  if (error) throw new ConsoleError('The batches could not be listed.', error.message, true)
  return ((data ?? []) as JobRow[]).map(summary)
}

export async function listJobsByStatus(status: JobStatus, limit: number): Promise<readonly JobSummary[]> {
  const { data, error } = await supabaseServer().from('agent_jobs').select(JOB_COLUMNS).eq('status', status).order('created_at', { ascending: false }).limit(limit)
  if (error) throw new ConsoleError('The batches could not be listed.', error.message, true)
  return ((data ?? []) as JobRow[]).map(summary)
}

export interface ClaimedJob {
  readonly id: string
  readonly label: string
  readonly photo_count: number
  readonly photos: readonly { id: string; filename: string; url: string }[]
}

export async function claimJob(runner: string, leaseSeconds: number): Promise<ClaimedJob | null> {
  const db = supabaseServer()
  const { data, error } = await db.rpc('agent_job_claim', { p_runner: runner, p_lease_seconds: leaseSeconds })
  if (error) throw rpcError('No job could be claimed.', error)
  const job = data as { id: string; label: string; photo_count: number } | null
  if (!job) return null
  const { data: photos, error: photosError } = await db.from('agent_job_photos')
    .select('id, filename, storage_key').eq('job_id', job.id).eq('status', 'uploaded').order('created_at', { ascending: true })
  if (photosError) throw new ConsoleError('The job photos could not be listed.', photosError.message, true)
  const store = consoleObjectStore()
  const signed = await Promise.all(((photos ?? []) as { id: string; filename: string; storage_key: string }[]).map(async (p) => ({
    id: p.id, filename: p.filename, url: await store.presignGet(p.storage_key, GET_TTL_SECONDS),
  })))
  return { id: job.id, label: job.label, photo_count: job.photo_count, photos: signed }
}

export async function heartbeatJob(jobId: string, runner: string, leaseSeconds: number): Promise<void> {
  const { error } = await supabaseServer().rpc('agent_job_heartbeat', { p_job_id: jobId, p_runner: runner, p_lease_seconds: leaseSeconds })
  if (error) throw rpcError('The heartbeat was refused.', error)
}

export async function finishJob(input: {
  jobId: string; runner: string; status: 'done' | 'failed'; note: string | null; error: string | null; resultCount: number
}): Promise<void> {
  const { error } = await supabaseServer().rpc('agent_job_finish', {
    p_job_id: input.jobId, p_runner: input.runner, p_status: input.status, p_note: input.note, p_error: input.error, p_result_count: input.resultCount,
  })
  if (error) throw rpcError('The job could not be finished.', error)
}
