import { actorFor, NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { listOpenOrders, readOrders, reportProgress, slipShopifyError } from '@/lib/shopify/slip-orders'
import { NothingToPrint, printSlips } from '@/lib/slips/print'
import { createBatch, finishBatch, insertRows, printedOrderIds, record, setProgress } from '@/lib/slips/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

/** Relative Locations: behind nginx the request URL is the bind address (127.0.0.1:3000), so an absolute redirect built from it would leave the site. */
const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } })
const back = (note: string) => redirect(`/dispatch/print?note=${encodeURIComponent(note)}`)

/** One click of Print slips: records the batch, tells Shopify, then sends the browser to the slip document to print.
 * A plain form POST, not a server action, so a page left open across a deploy still prints. */
export async function POST(request: Request) {
  try {
    const by = actorFor(await requireOperatorForAction())
    if (!isOwnOrigin(request.headers.get('origin'))) return new Response('Open Print slips in Loupe before printing.', { status: 403 })
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return new Response('Use the Print slips page.', { status: 415 })
    const form = new URLSearchParams(await request.text())
    const raw = (form.get('from') ?? '').replace(/\D/g, '')
    if ((form.get('from') ?? '').trim() && !raw) return back('Give the first order number to print, for example 6098, or leave the box empty.')
    const fromNumber = raw ? Number(raw) : null
    if (fromNumber !== null && (fromNumber < 1 || fromNumber > 99_999_999)) return back('That order number does not look right.')
    const client = new ShopifyClient()
    const outcome = await printSlips(by, fromNumber, {
      listOpenOrders: () => listOpenOrders(client), readOrders: ids => readOrders(client, ids), printedOrderIds, createBatch, insertRows, finishBatch, setProgress, record,
      reportProgress: (id, note) => reportProgress(client, id, note).then(() => undefined),
    })
    if (!outcome.printed) return back(`${outcome.baseline} order${outcome.baseline === 1 ? '' : 's'} recorded as printed before Loupe. Nothing to print.`)
    return redirect(`/api/slips/${outcome.batchId}?auto=1`)
  } catch (error) {
    if (error instanceof NotAuthorisedError) return new Response(error.message, { status: 401 })
    if (error instanceof NothingToPrint) return back(error.message)
    return back(slipShopifyError(error))
  }
}
