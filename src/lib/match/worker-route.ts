import 'server-only'

import { consoleObjectStore } from '@/lib/console/images'
import { isCronAuthorized } from '@/lib/cron/auth'
import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

import { WorkerApiError, type WorkerApiDeps } from './worker-api'

/** Real dependencies for the worker routes; the handlers themselves are pure. */
export function workerDeps(): WorkerApiDeps {
  return {
    db: supabaseServer(),
    presign: (key, ttl) => consoleObjectStore().presignGet(key, ttl),
    baseUrl: serverEnv.cronBaseUrl,
  }
}

export function unauthorizedWorker(request: Request): Response | null {
  let secret: string
  try {
    secret = serverEnv.workerSecret
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  return isCronAuthorized(request, secret)
    ? null
    : Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new WorkerApiError('Body must be a JSON object.', 400)
    }
    return body as Record<string, unknown>
  } catch (cause) {
    if (cause instanceof WorkerApiError) throw cause
    throw new WorkerApiError('Body is not valid JSON.', 400)
  }
}

export function workerFailure(error: unknown): Response {
  if (error instanceof WorkerApiError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status })
  }
  console.error('worker route failed:', error instanceof Error ? error.message : error)
  return Response.json({ ok: false, error: 'Worker request failed.' }, { status: 500 })
}
