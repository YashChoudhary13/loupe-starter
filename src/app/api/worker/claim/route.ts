import { claimJob, isJobKind, WorkerApiError } from '@/lib/match/worker-api'
import { readJson, unauthorizedWorker, workerDeps, workerFailure } from '@/lib/match/worker-route'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(request: Request): Promise<Response> {
  const denied = unauthorizedWorker(request)
  if (denied) return denied
  try {
    const body = await readJson(request)
    const kinds = Array.isArray(body.kinds) ? body.kinds : []
    if (!kinds.every(isJobKind)) throw new WorkerApiError('kinds must be sync, embed or identify', 400)
    const job = await claimJob(
      {
        workerId: String(body.worker_id ?? ''),
        kinds,
        leaseSeconds: typeof body.lease_seconds === 'number' ? body.lease_seconds : undefined,
      },
      workerDeps(),
    )
    return job ? Response.json(job) : new Response(null, { status: 204 })
  } catch (error) {
    return workerFailure(error)
  }
}
