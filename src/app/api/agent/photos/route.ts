import { listBatchPhotos, registerAgentPhoto } from '@/lib/agent-intake/restock'
import { AGENT_IMAGE_MAX_BYTES } from '@/lib/agent-intake/server'
import { AgentInputError, parseBatch } from '@/lib/agent-intake/suggest'
import { JOB_HEADERS as headers, authorized, bad, failure } from '@/lib/agent-jobs/http'

/**
 * D148: the phone photographs behind a batch. Bearer AGENT_SECRET only.
 * GET ?batch= lists the filenames Loupe already holds (a batch sent from the Enhance page has them
 * all); POST registers one that Claude was given outside Loupe, as multipart/form-data
 * (file, batch, optional filename), so deliveries, restock candidates and Re-enhance can name it.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  try {
    const batch = parseBatch(new URL(request.url).searchParams.get('batch'))
    if (!batch) return bad('Pass ?batch=<label>.')
    return Response.json({ ok: true, filenames: await listBatchPhotos(batch) }, { headers })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401, headers })
  // ponytail: formData() buffers the whole body; nginx caps requests at 50 MB and the byte check refuses above 25 MB.
  if (Number(request.headers.get('content-length') ?? '0') > AGENT_IMAGE_MAX_BYTES + 65_536) return bad('The photo is larger than 25 MB.', 413)
  let form: FormData
  try { form = await request.formData() } catch { return bad('Send multipart/form-data with a file field.') }
  try {
    const file = form.get('file')
    if (!(file instanceof File)) throw new AgentInputError('file is missing.')
    const batch = parseBatch(form.get('batch'))
    if (!batch) throw new AgentInputError('batch is missing.')
    const named = form.get('filename')
    const result = await registerAgentPhoto({
      batch,
      filename: (typeof named === 'string' && named.trim()) || file.name,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    })
    return Response.json({ ok: true, photo_id: result.photoId, duplicate: result.duplicate }, { headers })
  } catch (error) {
    return failure(error)
  }
}
