import { actorFor, NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { readOrders, slipShopifyError } from '@/lib/shopify/slip-orders'
import { renderSlipDocument } from '@/lib/slips/render'
import { loadBatch, record } from '@/lib/slips/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300
type Context = { params: Promise<{ batch: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The slip document for one batch, rendered fresh from Shopify. `?auto=1` opens the print dialog once the page has loaded. */
export async function GET(request: Request, context: Context) {
  try {
    const operator = await requireOperatorForAction()
    const { batch: batchId } = await context.params
    if (!UUID.test(batchId)) return new Response('No such batch.', { status: 404 })
    const batch = await loadBatch(batchId)
    if (!batch) return new Response('No such batch.', { status: 404 })
    const auto = new URL(request.url).searchParams.get('auto') === '1'
    const orders = await readOrders(new ShopifyClient(), batch.rows.filter(row => row.mark !== 'BASELINE').map(row => row.order_id))
    if (!auto) await record(batchId, 'slips.reprinted', { orders: batch.order_count }, actorFor(operator))
    const html = renderSlipDocument({ rows: batch.rows, orders, title: `Qimati packing slips ${batch.printed_at.slice(0, 10)}`, printedBy: batch.printed_by, printedAt: batch.printed_at, auto, backHref: '/dispatch/print' })
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' } })
  } catch (error) {
    if (error instanceof NotAuthorisedError) return new Response(error.message, { status: 401 })
    return new Response(slipShopifyError(error), { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
}
