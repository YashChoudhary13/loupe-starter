import { heartbeat } from '@/lib/match/worker-api'
import { readJson, unauthorizedWorker, workerDeps, workerFailure } from '@/lib/match/worker-route'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(request: Request): Promise<Response> {
  const denied = unauthorizedWorker(request)
  if (denied) return denied
  try {
    const body = await readJson(request)
    await heartbeat(
      {
        workerId: String(body.worker_id ?? ''),
        device: String(body.device ?? 'unknown'),
        kinds: Array.isArray(body.kinds) ? body.kinds.map(String) : [],
        version: String(body.version ?? ''),
      },
      workerDeps(),
    )
    return new Response(null, { status: 204 })
  } catch (error) {
    return workerFailure(error)
  }
}
