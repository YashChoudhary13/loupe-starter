import { completeJob, isJobKind, WorkerApiError } from '@/lib/match/worker-api'
import type { EmbedResult, IdentifyResult, SyncResult, WorkerFailure } from '@/lib/match/types'
import { readJson, unauthorizedWorker, workerDeps, workerFailure } from '@/lib/match/worker-route'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  const denied = unauthorizedWorker(request)
  if (denied) return denied
  try {
    const body = await readJson(request)
    if (!isJobKind(body.kind)) throw new WorkerApiError('kind must be sync, embed or identify', 400)
    const failure = body.error && typeof body.error === 'object' ? (body.error as WorkerFailure) : undefined
    const outcome = await completeJob(
      {
        jobId: String(body.job_id ?? ''),
        leaseToken: String(body.lease_token ?? ''),
        kind: body.kind,
        result: body.result as SyncResult | EmbedResult | IdentifyResult | undefined,
        error: failure
          ? { message: String(failure.message ?? 'worker error'), retryable: Boolean(failure.retryable) }
          : undefined,
      },
      workerDeps(),
    )
    return Response.json({ ok: true, ...outcome })
  } catch (error) {
    return workerFailure(error)
  }
}
