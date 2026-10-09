import { parseJobStatus, parseLeaseSeconds, parseRunner } from '@/lib/agent-jobs/label'
import { JOB_HEADERS as headers, authorized, bad, failure, readBody } from '@/lib/agent-jobs/http'
import { claimJob, listJobsByStatus } from '@/lib/agent-jobs/server'

/**
 * D143: the enhancer's side of the job queue. Bearer AGENT_SECRET only.
 * POST {action:'claim', runner, lease_seconds} takes one job; GET ?status= lists.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  try {
    const body = await readBody(request)
    if (body.action !== 'claim') return bad('Unknown action. Use claim.')
    const job = await claimJob(parseRunner(body.runner), parseLeaseSeconds(body.lease_seconds))
    return Response.json({ ok: true, job }, { headers })
  } catch (error) {
    return failure(error)
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  try {
    const url = new URL(request.url)
    const status = parseJobStatus(url.searchParams.get('status') ?? 'queued')
    const limitRaw = Number(url.searchParams.get('limit') ?? '20')
    const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20
    return Response.json({ ok: true, jobs: await listJobsByStatus(status, limit) }, { headers })
  } catch (error) {
    return failure(error)
  }
}
