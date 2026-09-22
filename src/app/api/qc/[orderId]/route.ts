import { NotAuthorisedError, requireOperatorIdForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { loadQcView } from '@/lib/qc/server'
import { orderGid, parseQcCommand } from '@/lib/qc/validation'
import { qcShopifyError } from '@/lib/shopify/qc-orders'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
type Context = { params: Promise<{ orderId: string }> }

function failure(error: unknown) {
  return Response.json({ error: qcShopifyError(error) }, { status: error instanceof NotAuthorisedError ? 401 : 400, headers })
}

export async function GET(_request: Request, context: Context) {
  try {
    const operator = await requireOperatorIdForAction()
    const { orderId } = await context.params
    return Response.json(await loadQcView(orderGid(orderId), operator), { headers })
  } catch (error) { return failure(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const operator = await requireOperatorIdForAction()
    if (!isOwnOrigin(request.headers.get('origin'))) return Response.json({ error: 'Open QC in Loupe to scan products.' }, { status: 403, headers })
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return Response.json({ error: 'Use the QC scan form.' }, { status: 415, headers })
    if (Number(request.headers.get('content-length') ?? '0') > 4096) return Response.json({ error: 'QC request too large.' }, { status: 413, headers })
    const reader = request.body?.getReader()
    if (!reader) throw new Error('No QC action received.')
    let size = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return Response.json({ error: 'QC request too large.' }, { status: 413, headers }) }
      chunks.push(value)
    }
    const command = parseQcCommand(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const { orderId } = await context.params
    return Response.json(await loadQcView(orderGid(orderId), operator, command), { headers })
  } catch (error) { return failure(error) }
}
