import { serverEnv } from '@/lib/env'
import { isCronAuthorized } from '@/lib/cron/auth'
import { listShortages, resolveShortage } from '@/lib/qc/shortages'

/**
 * Machine endpoint for the WhatsApp bot (n8n). Bearer QC_BOT_SECRET only; no operator session,
 * no browser origin. Read-only apart from marking a shortage resolved. Never touches Shopify.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function authorized(request: Request): boolean {
  try { return isCronAuthorized(request, serverEnv.qcBotSecret) } catch { return false }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers })
  if (Number(request.headers.get('content-length') ?? '0') > 4096) return Response.json({ ok: false, error: 'Request too large.' }, { status: 413, headers })
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 4096) return Response.json({ ok: false, error: 'Request too large.' }, { status: 413, headers })
    body = text ? JSON.parse(text) : {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch { return Response.json({ ok: false, error: 'Send a JSON object.' }, { status: 400, headers }) }
  try {
    if (body.action === 'list') {
      const days = Number.isSafeInteger(body.days) && Number(body.days) > 0 ? Math.min(Number(body.days), 365) : 30
      return Response.json({ ok: true, ...(await listShortages(days)) }, { headers })
    }
    if (body.action === 'resolve') {
      const by = typeof body.by === 'string' && body.by.trim() ? `WhatsApp ${body.by.trim().slice(0, 40)}` : 'WhatsApp'
      const result = await resolveShortage({ ref: body.ref, resolution: body.resolution, note: body.note, by })
      return Response.json({ ok: true, ...result }, { headers })
    }
    return Response.json({ ok: false, error: 'Unknown action. Use list or resolve.' }, { status: 400, headers })
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Shortage request failed.' }, { status: 400, headers })
  }
}
