'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { JobInputError } from '@/lib/agent-jobs/label'
import { beginJobPhotoUpload, createJob, finishJobPhotoUpload, listJobs, queueJob, type JobSummary } from '@/lib/agent-jobs/server'
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
