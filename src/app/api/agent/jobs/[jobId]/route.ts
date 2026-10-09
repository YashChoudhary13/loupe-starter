import { JobInputError, parseLeaseSeconds, parseRunner } from '@/lib/agent-jobs/label'
import { finishJob, heartbeatJob } from '@/lib/agent-jobs/server'

import { JOB_HEADERS as headers, authorized, bad, failure, readBody } from '@/lib/agent-jobs/http'

/** D143: heartbeat, done or failed for one claimed job. Bearer AGENT_SECRET only. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function text(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new JobInputError('note and error must be strings.')
  const value = raw.trim()
  return value ? value.slice(0, max) : null
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  try {
    const { jobId } = await context.params
    if (!UUID.test(jobId)) throw new JobInputError('That job id is not a UUID.')
    const body = await readBody(request)
    const runner = parseRunner(body.runner)
    if (body.action === 'heartbeat') {
      await heartbeatJob(jobId, runner, parseLeaseSeconds(body.lease_seconds))
      return Response.json({ ok: true }, { headers })
    }
    if (body.action === 'done' || body.action === 'failed') {
      const count = body.result_count ?? 0
      if (!Number.isSafeInteger(count) || Number(count) < 0) throw new JobInputError('result_count must be a whole number.')
      await finishJob({ jobId, runner, status: body.action, note: text(body.note, 500), error: text(body.error, 2000), resultCount: Number(count) })
      return Response.json({ ok: true }, { headers })
    }
    return bad('Unknown action. Use heartbeat, done or failed.')
  } catch (error) {
    return failure(error)
  }
}
