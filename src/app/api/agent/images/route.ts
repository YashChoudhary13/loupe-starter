import { serverEnv } from '@/lib/env'
import { isCronAuthorized } from '@/lib/cron/auth'
import { ConsoleError } from '@/lib/console/mutations'
import { AGENT_IMAGE_MAX_BYTES, ingestAgentImage, listAgentBatch, replaceAgentImage } from '@/lib/agent-intake/server'
import { AgentInputError, parseAgentSuggest, parseAgentTag, parseBatch, parseNote, parseReplaces, parseRestockSku, parseSourceFilename } from '@/lib/agent-intake/suggest'

/**
 * D142: machine endpoint for Claude, the enhancer. Bearer AGENT_SECRET only; no operator
 * session, no browser origin. POST one finished image as multipart/form-data; GET a batch.
 * Never touches Shopify.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function authorized(request: Request): boolean {
  try { return isCronAuthorized(request, serverEnv.agentSecret) } catch { return false }
}

function bad(error: string, status = 400) {
  return Response.json({ ok: false, error }, { status, headers })
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  // ponytail: formData() buffers the whole body; nginx caps requests at 50 MB and the byte check below refuses above 25 MB.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > AGENT_IMAGE_MAX_BYTES + 65_536) return bad('The file is larger than 25 MB.', 413)
  let form: FormData
  try { form = await request.formData() } catch { return bad('Send multipart/form-data with a file field.') }
  try {
    const file = form.get('file')
    if (!(file instanceof File)) throw new AgentInputError('file is missing.')
    if (!MIME_TYPES.has(file.type)) throw new AgentInputError('file must be a PNG, JPEG or WebP.')
    const filenameField = form.get('filename')
    const filename = (typeof filenameField === 'string' && filenameField.trim()) || file.name
    const tag = parseAgentTag(form.get('tag'))
    const note = parseNote(form.get('note'))
    const batch = parseBatch(form.get('batch'))
    const replaces = parseReplaces(form.get('replaces'))
    const bytes = Buffer.from(await file.arrayBuffer())
    if (replaces) {
      // D145: a redo's render takes the old image's place on the same intake row.
      const result = await replaceAgentImage({ intakeId: replaces, bytes, mimeType: file.type, tag, note, batch })
      return Response.json({ ok: true, intake_id: result.intakeId, status: result.status, duplicate: result.duplicate, replaced: result.replaced, version_no: result.versionNo }, { headers })
    }
    const result = await ingestAgentImage({
      bytes,
      filename,
      mimeType: file.type,
      tag,
      note,
      restockSku: parseRestockSku(form.get('restock_sku'), tag),
      suggest: parseAgentSuggest(form.get('suggest')),
      batch,
      sourceFilename: parseSourceFilename(form.get('source_filename')),
    })
    return Response.json({ ok: true, intake_id: result.intakeId, status: result.status, duplicate: result.duplicate }, { headers })
  } catch (error) {
    if (error instanceof AgentInputError) return bad(error.message)
    if (error instanceof ConsoleError) return bad(error.detail ? `${error.operatorMessage} ${error.detail}` : error.operatorMessage, error.retryable ? 503 : 400)
    return bad(error instanceof Error ? error.message : 'The upload failed.', 500)
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  const batch = new URL(request.url).searchParams.get('batch')?.trim() ?? ''
  if (!batch || batch.length > 80) return bad('Pass ?batch=<label>.')
  try {
    return Response.json({ ok: true, rows: await listAgentBatch(batch) }, { headers })
  } catch (error) {
    return bad(error instanceof Error ? error.message : 'The batch could not be listed.', 503)
  }
}
