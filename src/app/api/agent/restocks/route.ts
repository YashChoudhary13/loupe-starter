import { postRestockCandidate } from '@/lib/agent-intake/restock'
import { AgentInputError, parseBatch, parseRestockPayload, parseSourceFilename } from '@/lib/agent-intake/suggest'
import { JOB_HEADERS as headers, authorized, failure, readBody } from '@/lib/agent-jobs/http'

/**
 * D148: Claude says a phone photograph is (kind old) or may be (kind unsure) a piece the shop
 * already sells. Bearer AGENT_SECRET only. JSON: batch, source_filename, kind, note, candidates
 * [{sku, handle, title, image_url, status, available, price_paise, created_at, suggest}].
 * Nothing is rendered or sent to Pending; an operator decides in the Restock section.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
const BODY_MAX = 32_768

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  try {
    const body = await readBody(request, BODY_MAX)
    const batch = parseBatch(body.batch)
    const sourceFilename = parseSourceFilename(body.source_filename)
    if (!batch || !sourceFilename) throw new AgentInputError('batch and source_filename are required.')
    const result = await postRestockCandidate(batch, sourceFilename, parseRestockPayload(body))
    return Response.json({ ok: true, photo_id: result.photoId, state: result.state }, { headers })
  } catch (error) {
    return failure(error)
  }
}
