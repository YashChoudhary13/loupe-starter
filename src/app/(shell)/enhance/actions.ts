'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { JobInputError } from '@/lib/agent-jobs/label'
import { beginJobPhotoUpload, createJob, finishJobPhotoUpload, listJobs, queueJob, type JobSummary } from '@/lib/agent-jobs/server'
import type { JobPhoto, RunnerView } from '@/lib/agent-jobs/tracking'
import { jobThumbUrls, listJobPhotos, retryJobPhotos, runnerView, sendRunnerCommand, cancelJob } from '@/lib/agent-jobs/tracking-server'
import { ConsoleError } from '@/lib/console/mutations'

/** D143 — the Enhance jobs page. Same result contract as the Upload section. */

export type EnhanceActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly message: string; readonly detail: string | null; readonly retryable: boolean } }

async function withOperator<T>(run: (operator: Awaited<ReturnType<typeof requireOperatorForAction>>) => Promise<T>): Promise<EnhanceActionResult<T>> {
  try {
    return { ok: true, data: await run(await requireOperatorForAction()) }
  } catch (cause) {
    if (cause instanceof NotAuthorisedError || cause instanceof JobInputError) return { ok: false, error: { message: cause.message, detail: null, retryable: false } }
    if (cause instanceof ConsoleError) return { ok: false, error: { message: cause.operatorMessage, detail: cause.detail, retryable: cause.retryable } }
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.error('enhance action failed:', detail)
    return { ok: false, error: { message: 'That did not work. Try again.', detail, retryable: true } }
  }
}

export async function createJobAction(label: string): Promise<EnhanceActionResult<JobSummary>> {
  return withOperator((operator) => createJob(operator, label))
}

export async function beginJobPhotoUploadAction(input: { jobId: string; filename: string; mimeType: string; bytes: number }) {
  return withOperator((operator) => beginJobPhotoUpload(operator, input))
}

export async function finishJobPhotoUploadAction(photoId: string): Promise<EnhanceActionResult<{ photoCount: number }>> {
  return withOperator((operator) => finishJobPhotoUpload(operator, photoId))
}

export async function queueJobAction(jobId: string): Promise<EnhanceActionResult<readonly JobSummary[]>> {
  return withOperator(async (operator) => {
    await queueJob(operator, jobId)
    return listJobs()
  })
}

export async function listJobsAction(): Promise<EnhanceActionResult<readonly JobSummary[]>> {
  return withOperator(() => listJobs())
}

// ---------------------------------------------------------------------------------------------
// D170: per-photo tracking and the server panel

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuids = (raw: readonly string[]): string[] => raw.filter((id) => typeof id === 'string' && UUID.test(id))

export interface EnhanceState {
  readonly jobs: readonly JobSummary[]
  readonly runner: RunnerView | null
  /** Photographs of the batches open on the page, by job id. States only; a poll never signs an image. */
  readonly photos: Readonly<Record<string, readonly JobPhoto[]>>
}

async function enhanceState(openJobIds: readonly string[]): Promise<EnhanceState> {
  const [jobs, runner, photos] = await Promise.all([listJobs(), runnerView(), listJobPhotos(uuids(openJobIds))])
  return { jobs, runner, photos }
}

export async function enhanceStateAction(openJobIds: readonly string[]): Promise<EnhanceActionResult<EnhanceState>> {
  return withOperator(() => enhanceState(openJobIds))
}

export async function jobThumbsAction(jobId: string): Promise<EnhanceActionResult<Readonly<Record<string, string>>>> {
  return withOperator(async () => (UUID.test(jobId) ? jobThumbUrls(jobId) : {}))
}

/** Sends failed photographs back to the queue: the ones named, or every failed one of the batch. */
export async function retryPhotosAction(jobId: string, photoIds: readonly string[] | null, openJobIds: readonly string[]): Promise<EnhanceActionResult<EnhanceState>> {
  return withOperator(async (operator) => {
    if (!UUID.test(jobId)) throw new JobInputError('That batch was not found.')
    await retryJobPhotos(operator, jobId, photoIds ? uuids(photoIds) : null)
    return enhanceState(openJobIds)
  })
}

/** Cancels what is left of a batch. */
export async function cancelJobAction(jobId: string, openJobIds: readonly string[]): Promise<EnhanceActionResult<EnhanceState>> {
  return withOperator(async (operator) => {
    if (!UUID.test(jobId)) throw new JobInputError('That batch was not found.')
    await cancelJob(operator, jobId)
    return enhanceState(openJobIds)
  })
}

export async function runnerCommandAction(kind: string, payload: Record<string, string>): Promise<EnhanceActionResult<null>> {
  return withOperator(async (operator) => {
    await sendRunnerCommand(operator, kind, payload)
    return null
  })
}
