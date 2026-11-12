import { NotAuthorisedError, requireOperatorIdForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { clubScan, loadClubView } from '@/lib/qc/club'
import { orderGid, parseQcCommand } from '@/lib/qc/validation'
import { qcShopifyError } from '@/lib/shopify/qc-orders'

/** Club QC (D168): GET = every member's checklist; POST = one scan, counted in the member the server picks. Every other action goes to /api/qc/<order>. */
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
    const view = await loadClubView(orderGid(orderId), operator)
    if (!view) return Response.json({ error: 'This order is no longer clubbed. Go back to the order list and open it again.' }, { status: 409, headers })
    return Response.json(view, { headers })
  } catch (error) { return failure(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const operator = await requireOperatorIdForAction()
    if (!isOwnOrigin(request.headers.get('origin'))) return Response.json({ error: 'Open QC in Loupe to scan products.' }, { status: 403, headers })
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return Response.json({ error: 'Use the QC scan form.' }, { status: 415, headers })
    const text = await request.text()
    if (text.length > 4096) return Response.json({ error: 'QC request too large.' }, { status: 413, headers })
    const input = JSON.parse(text)
    // The browser does not know which member the unit belongs to, so it sends no generation; the server supplies the target's.
    const command = parseQcCommand({ ...input, expectedGeneration: 1 })
    if (command.action !== 'scan') throw new Error('Only scans go to the club. Other actions belong to one order.')
    const { orderId } = await context.params
    return Response.json(await clubScan(orderGid(orderId), operator, command), { headers })
  } catch (error) { return failure(error) }
}
