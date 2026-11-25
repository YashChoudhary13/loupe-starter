import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { JobInputError } from '@/lib/agent-jobs/label'
import { beginJobPhotoUpload, createJob, finishJobPhotoUpload, listJobs, queueJob } from '@/lib/agent-jobs/server'
import { listJobPhotos } from '@/lib/agent-jobs/tracking-server'
import { ConsoleError } from '@/lib/console/mutations'
import { isOwnOrigin } from '@/lib/faces/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const refuse = (message: string, status: number, retryable = false) => answer({ ok: false, error: { message, detail: null, retryable } }, status)

/**
 * D179: the Enhance uploader's own door. A fetch of a route, not Server Actions: Next sends a page's actions one at a
 * time and ties them to the screen that is open, so sixty photographs queued behind each other (and behind the page's
 * poll) and stopped when the operator opened another section. These run side by side and belong to no screen.
 * Same functions and the same result shape as the actions in `(shell)/enhance/actions.ts`.
 */
export async function POST(request: Request) {
  try {
    const operator = await requireOperatorForAction()
    if (!isOwnOrigin(request.headers.get('origin'))) return refuse('Open Enhance in Loupe to upload.', 403)
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return refuse('Use the Enhance page.', 415)
    const text = await request.text()
    if (text.length > 4096) return refuse('Request too large.', 413)
    const body = JSON.parse(text) as Record<string, unknown>
    const id = (value: unknown): string => {
      if (typeof value !== 'string' || !UUID.test(value)) throw new JobInputError('That batch or photo was not found.')
      return value
    }
    switch (body.op) {
      case 'create': return answer({ ok: true, data: await createJob(operator, body.label) })
      case 'begin': return answer({ ok: true, data: await beginJobPhotoUpload(operator, {
        jobId: id(body.jobId), filename: String(body.filename ?? ''), mimeType: String(body.mimeType ?? ''), bytes: Number(body.bytes),
      }) })
      case 'finish': return answer({ ok: true, data: await finishJobPhotoUpload(operator, id(body.photoId)) })
      case 'send': {
        await queueJob(operator, id(body.jobId))
        return answer({ ok: true, data: await listJobs() })
      }
      // The filenames a batch already holds, so picking the same photographs again sends only the missing ones.
      case 'names': {
        const jobId = id(body.jobId)
        return answer({ ok: true, data: ((await listJobPhotos([jobId]))[jobId] ?? []).map((p) => p.filename) })
      }
      default: return refuse('Unknown request.', 400)
    }
  } catch (cause) {
    if (cause instanceof NotAuthorisedError) return refuse(cause.message, 401)
    if (cause instanceof JobInputError || cause instanceof SyntaxError) return refuse(cause instanceof JobInputError ? cause.message : 'Send a JSON object.', 400)
    if (cause instanceof ConsoleError) return answer({ ok: false, error: { message: cause.operatorMessage, detail: cause.detail, retryable: cause.retryable } }, cause.retryable ? 503 : 400)
    console.error('enhance upload failed:', cause instanceof Error ? cause.message : String(cause))
    return refuse('That did not work. Try again.', 500, true)
  }
}
