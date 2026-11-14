import { JobInputError, parseRunner } from '@/lib/agent-jobs/label'
import { JOB_HEADERS as headers, authorized, failure, readBody } from '@/lib/agent-jobs/http'
import { reportRunner } from '@/lib/agent-jobs/tracking-server'

/**
 * D170: the runner's heartbeat. Bearer AGENT_SECRET only. Every ten seconds the server says how it
 * is (limits, sign-in, what it works on, the tail of its log) and which commands it has finished;
 * the answer carries the commands waiting for it. Fixed command kinds only.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30
const BODY_MAX = 64_000

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  try {
    const body = await readBody(request, BODY_MAX)
    const runner = parseRunner(body.runner)
    const status = body.status && typeof body.status === 'object' && !Array.isArray(body.status) ? body.status : {}
    if (body.log !== undefined && typeof body.log !== 'string') throw new JobInputError('log must be text.')
    const results = Array.isArray(body.results) ? body.results.slice(0, 20) : []
    const commands = await reportRunner(runner, status, typeof body.log === 'string' ? body.log : '', results)
    return Response.json({ ok: true, commands }, { headers })
  } catch (error) {
    return failure(error)
  }
}
