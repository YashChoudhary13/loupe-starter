import 'server-only'

import type { Operator } from '@/lib/auth/authorize'
import { consoleObjectStore } from '@/lib/console/images'
import { ConsoleError } from '@/lib/console/mutations'
import { supabaseServer } from '@/lib/supabase/server'

import {
  NO_COUNTS, countPhotos, parsePhotoState, parseRunnerCommand, parseRunnerView,
  type JobPhoto, type PassOutcome, type PhotoCounts, type PhotoState, type RunnerView,
} from './tracking'

/**
 * D170: the page's view of every photograph and of the runner, and the two doors the runner uses
 * (a pass report, a heartbeat). The database decides what is done; nothing here guesses.
 */

const THUMB_TTL_SECONDS = 6 * 60 * 60
const PHOTO_TTL_SECONDS = 10 * 60

function fail(message: string, error: { code?: string; message: string }): ConsoleError {
  return new ConsoleError(message, [error.code, error.message].filter(Boolean).join(' · '), error.code !== '55000' && error.code !== '22023' && error.code !== 'P0002')
}

/** Counts per state for each job, in one read. */
export async function photoCountsFor(jobIds: readonly string[]): Promise<ReadonlyMap<string, PhotoCounts>> {
  const out = new Map<string, PhotoCounts>()
  if (jobIds.length === 0) return out
  const { data, error } = await supabaseServer()
    .from('agent_job_photos').select('job_id, work_state').in('job_id', [...jobIds]).eq('status', 'uploaded').limit(10_000)
  if (error) throw new ConsoleError('The photographs could not be counted.', error.message, true)
  const byJob = new Map<string, PhotoState[]>()
  for (const row of (data ?? []) as { job_id: string; work_state: string }[]) {
    const list = byJob.get(row.job_id) ?? []
    list.push(parsePhotoState(row.work_state))
    byJob.set(row.job_id, list)
  }
  for (const id of jobIds) out.set(id, byJob.has(id) ? countPhotos(byJob.get(id) ?? []) : NO_COUNTS)
  return out
}

interface PhotoRow { id: string; job_id: string; filename: string; work_state: string; attempts: number; last_error: string | null; thumb_key: string | null }

/** Every photograph of the named jobs with its state. No image URLs: this is what the page polls. */
export async function listJobPhotos(jobIds: readonly string[]): Promise<Readonly<Record<string, readonly JobPhoto[]>>> {
  const out: Record<string, JobPhoto[]> = {}
  const ids = jobIds.slice(0, 12)
  if (ids.length === 0) return out
  const { data, error } = await supabaseServer()
    .from('agent_job_photos').select('id, job_id, filename, work_state, attempts, last_error, thumb_key')
    .in('job_id', ids).eq('status', 'uploaded').order('created_at', { ascending: true }).order('id', { ascending: true }).limit(5000)
  if (error) throw new ConsoleError('The photographs could not be listed.', error.message, true)
  for (const id of ids) out[id] = []
  for (const r of (data ?? []) as PhotoRow[]) {
    out[r.job_id]?.push({ id: r.id, filename: r.filename, state: parsePhotoState(r.work_state), attempts: r.attempts, lastError: r.last_error, hasThumb: Boolean(r.thumb_key) })
  }
  return out
}

/** Signed thumbnail URLs for one job, fetched once when its grid opens (a poll must never re-sign them). */
export async function jobThumbUrls(jobId: string): Promise<Readonly<Record<string, string>>> {
  const { data, error } = await supabaseServer()
    .from('agent_job_photos').select('id, thumb_key, storage_key').eq('job_id', jobId).eq('status', 'uploaded').limit(1000)
  if (error) throw new ConsoleError('The thumbnails could not be listed.', error.message, true)
  const store = consoleObjectStore()
  // A photograph from before D170 (or whose thumbnail upload failed) has no thumbnail: show the phone photograph itself.
  const pairs = await Promise.all(((data ?? []) as { id: string; thumb_key: string | null; storage_key: string }[])
    .map(async (r) => [r.id, await store.presignGet(r.thumb_key ?? r.storage_key, THUMB_TTL_SECONDS)] as const))
  return Object.fromEntries(pairs)
}

/** The phone photograph itself, signed on the tap. */
export async function jobPhotoUrl(photoId: string): Promise<string> {
  const { data, error } = await supabaseServer().from('agent_job_photos').select('storage_key').eq('id', photoId).maybeSingle<{ storage_key: string }>()
  if (error || !data) throw new ConsoleError('That photograph was not found.', error?.message ?? null, false)
  return consoleObjectStore().presignGet(data.storage_key, PHOTO_TTL_SECONDS)
}

export async function retryJobPhotos(operator: Operator, jobId: string, photoIds: readonly string[] | null): Promise<number> {
  const { data, error } = await supabaseServer().rpc('agent_job_retry_photos', { p_job_id: jobId, p_photo_ids: photoIds ? [...photoIds] : null, p_actor: operator.email })
  if (error) throw fail('The photographs could not be sent back.', error)
  return typeof data === 'number' ? data : 0
}

/** The owner cancels a batch: what is not done yet leaves the queue. A pass already running ends by itself. */
export async function cancelJob(operator: Operator, jobId: string): Promise<number> {
  const { data, error } = await supabaseServer().rpc('agent_job_cancel', { p_job_id: jobId, p_actor: operator.email })
  if (error) throw fail('The batch could not be cancelled.', error)
  return typeof data === 'number' ? data : 0
}

/** A delivery or a restock card just landed for this photograph; the page should show it at once. */
export async function markPhotoDelivered(photoId: string, state: 'done' | 'restock'): Promise<void> {
  // ponytail: best effort for liveness only. agent_job_sync_photos recomputes the truth at every claim and pass end.
  await supabaseServer().from('agent_job_photos').update({ work_state: state, worked_at: new Date().toISOString(), last_error: null })
    .eq('id', photoId).in('work_state', ['waiting', 'working', 'failed', 'cancelled'])
}

/** A redo's replacement landed: its job's one photograph is done. */
export async function markJobPhotosDelivered(jobId: string): Promise<void> {
  await supabaseServer().from('agent_job_photos').update({ work_state: 'done', worked_at: new Date().toISOString(), last_error: null })
    .eq('job_id', jobId).in('work_state', ['waiting', 'working', 'failed', 'cancelled'])
}

export async function passJob(input: {
  jobId: string; runner: string; outcome: PassOutcome; resumeAt: string | null; note: string | null; error: string | null; resultCount: number
}): Promise<string> {
  const { data, error } = await supabaseServer().rpc('agent_job_pass', {
    p_job_id: input.jobId, p_runner: input.runner, p_outcome: input.outcome, p_resume_at: input.resumeAt,
    p_note: input.note, p_error: input.error, p_result_count: input.resultCount,
  })
  if (error) throw fail('The pass could not be recorded.', error)
  return typeof data === 'string' ? data : 'queued'
}

// ---------------------------------------------------------------------------------------------
// The runner

export async function runnerView(now = new Date()): Promise<RunnerView | null> {
  const { data, error } = await supabaseServer()
    .from('agent_runner_status').select('runner, status, log, seen_at').order('seen_at', { ascending: false }).limit(1)
    .maybeSingle<{ runner: string; status: unknown; log: string; seen_at: string }>()
  if (error) throw new ConsoleError('The server report could not be read.', error.message, true)
  return parseRunnerView(data, now)
}

export interface RunnerCommandOut { readonly id: string; readonly kind: string; readonly payload: unknown }

/** The runner's heartbeat: stores its report and answers with the commands waiting for it. */
export async function reportRunner(runner: string, status: unknown, log: string, results: readonly unknown[]): Promise<readonly RunnerCommandOut[]> {
  const { data, error } = await supabaseServer().rpc('agent_runner_report', { p_runner: runner, p_status: status, p_log: log, p_results: results })
  if (error) throw fail('The report could not be stored.', error)
  // A limit can end before its clock time (a seat reset by hand). Once the server says it is ready again,
  // the batches that wait for the limit may be claimed at once. The one-minute wait after a failed try has
  // no hold_reason and is left alone.
  const state = (status as { state?: unknown } | null)?.state
  if (state === 'idle' || state === 'working') {
    const { error: releaseError } = await supabaseServer().from('agent_jobs').update({ not_before: null, hold_reason: null }).eq('status', 'queued').eq('hold_reason', 'limit')
    if (releaseError) console.error('enhance: could not release limit holds', releaseError.message)
  }
  return Array.isArray(data) ? (data as RunnerCommandOut[]) : []
}

export async function sendRunnerCommand(operator: Operator, rawKind: unknown, rawPayload: unknown): Promise<void> {
  const { kind, payload } = parseRunnerCommand(rawKind, rawPayload)
  const db = supabaseServer()
  const { data: row, error: readError } = await db.from('agent_runner_status').select('runner').order('seen_at', { ascending: false }).limit(1).maybeSingle<{ runner: string }>()
  if (readError) throw new ConsoleError('The server report could not be read.', readError.message, true)
  if (!row) throw new ConsoleError('The server has not reported yet, so there is nobody to ask.', null, false)
  if (kind === 'try_now') {
    const { error } = await db.rpc('agent_jobs_release_holds', { p_actor: operator.email })
    if (error) throw fail('The waiting batches could not be released.', error)
  }
  const { error } = await db.from('agent_runner_commands').insert({ runner: row.runner, kind, payload, created_by: operator.email })
  if (error) throw new ConsoleError('The request could not be sent to the server.', error.message, true)
  // The commands table is the trail (who, what, when). A sign-in code sits in `payload` only until the runner
  // answers; agent_runner_report wipes it then. It is single-use and useless without the browser session that made it.
}
