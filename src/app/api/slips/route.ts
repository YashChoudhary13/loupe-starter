import { actorFor, NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { listOpenOrders, readOrders, reportProgress, slipShopifyError } from '@/lib/shopify/slip-orders'
import { NothingToPrint, printSlips } from '@/lib/slips/print'
import { renderSlipDocument, SLIP_DOCUMENT_HEADERS } from '@/lib/slips/render'
import { createBatch, finishBatch, insertRows, printedOrderIds, record, setProgress } from '@/lib/slips/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

/** A plain-text answer the page shows in place: 409 when nothing was printed, 400 for a problem. */
const text = (message: string, status: number) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

/** One click of Print slips: records the batch, tells Shopify, and answers with the slip document, rendered from the orders
 * just read; the page prints it from a hidden frame (D152). A fetch of a route, not a server action, so a page left open
 * across a deploy still prints. */
export async function POST(request: Request) {
  try {
    const by = actorFor(await requireOperatorForAction())
    if (!isOwnOrigin(request.headers.get('origin'))) return new Response('Open Print slips in Loupe before printing.', { status: 403 })
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return new Response('Use the Print slips page.', { status: 415 })
    const form = new URLSearchParams(await request.text())
    const raw = (form.get('from') ?? '').replace(/\D/g, '')
    if ((form.get('from') ?? '').trim() && !raw) return text('Give the first order number to print, for example 6098, or leave the box empty.', 400)
    const fromNumber = raw ? Number(raw) : null
    if (fromNumber !== null && (fromNumber < 1 || fromNumber > 99_999_999)) return text('That order number does not look right.', 400)
    const client = new ShopifyClient()
    const outcome = await printSlips(by, fromNumber, {
      listOpenOrders: () => listOpenOrders(client), readOrders: ids => readOrders(client, ids), printedOrderIds, createBatch, insertRows, finishBatch, setProgress, record,
      reportProgress: (id, note) => reportProgress(client, id, note).then(() => undefined),
    })
    if (!outcome.printed) return text(`${outcome.baseline} order${outcome.baseline === 1 ? '' : 's'} recorded as printed before Loupe. Nothing to print.`, 409)
    const html = renderSlipDocument({ rows: outcome.rows, orders: outcome.orders, title: `Qimati packing slips ${outcome.printedAt.slice(0, 10)}`, printedBy: by, printedAt: outcome.printedAt, backHref: '/dispatch/print' })
    return new Response(html, { headers: SLIP_DOCUMENT_HEADERS })
  } catch (error) {
    if (error instanceof NotAuthorisedError) return new Response(error.message, { status: 401 })
    if (error instanceof NothingToPrint) return text(error.message, 409)
    return text(slipShopifyError(error), 400)
  }
}
