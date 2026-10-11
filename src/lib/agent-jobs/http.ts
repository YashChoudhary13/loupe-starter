import { AgentInputError } from '@/lib/agent-intake/suggest'
import { JobInputError } from '@/lib/agent-jobs/label'
import { ConsoleError } from '@/lib/console/mutations'
import { isCronAuthorized } from '@/lib/cron/auth'
import { serverEnv } from '@/lib/env'

/** D143: shared plumbing for the /api/agent/jobs routes. */
export const JOB_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const BODY_MAX = 8192

export function authorized(request: Request): boolean {
  try { return isCronAuthorized(request, serverEnv.agentSecret) } catch { return false }
}

export function bad(error: string, status = 400) {
  return Response.json({ ok: false, error }, { status, headers: JOB_HEADERS })
}

export async function readBody(request: Request, max = BODY_MAX): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? '0') > max) throw new JobInputError('Request too large.')
  const text = await request.text()
  if (text.length > max) throw new JobInputError('Request too large.')
  const body: unknown = text ? JSON.parse(text) : {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new JobInputError('Send a JSON object.')
  return body as Record<string, unknown>
}

export function failure(error: unknown) {
  if (error instanceof SyntaxError) return bad('Send a JSON object.')
  if (error instanceof JobInputError || error instanceof AgentInputError) return bad(error.message)
  if (error instanceof ConsoleError) return bad(error.detail ? `${error.operatorMessage} ${error.detail}` : error.operatorMessage, error.retryable ? 503 : 400)
  return bad(error instanceof Error ? error.message : 'The request failed.', 500)
}
