import { actorFor, NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { ShopifyClient } from '@/lib/shopify/client'
import { readOrders, slipShopifyError } from '@/lib/shopify/slip-orders'
import { carrierLookup } from '@/lib/slips/carrier'
import { phoneDigits } from '@/lib/slips/plan'
import { NoSuchSlip, reprintOne } from '@/lib/slips/print'
import { renderSlipDocument, SLIP_DOCUMENT_HEADERS } from '@/lib/slips/render'
import { loadRowByNumber, record, saveStrip } from '@/lib/slips/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
type Context = { params: Promise<{ number: string }> }
const text = (message: string, status: number) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

/** One order's slip again, rendered fresh from Shopify (D181). A slip that was printed as Need Address and has its
 * address by now prints with the address and its courier. */
export async function GET(_request: Request, context: Context) {
  try {
    const by = actorFor(await requireOperatorForAction())
    const orderNumber = Number((await context.params).number)
    if (!Number.isInteger(orderNumber) || orderNumber < 1 || orderNumber > 99_999_999) return text('Give the order number, for example 9058.', 400)
    const client = new ShopifyClient()
    const { row, order, refreshed } = await reprintOne(orderNumber, {
      loadRow: loadRowByNumber, saveStrip, readOrders: ids => readOrders(client, ids), carrierFor: carrierLookup(serverEnv.delhiveryApiKey),
      delhiveryPhones: new Set(serverEnv.delhiveryPhones.split(',').map(phone => phoneDigits(phone)).filter((phone): phone is string => !!phone)),
    })
    await record(row.batch_id, 'slips.reprinted_one', { order: row.order_name, refreshed, courier: row.strip.carrier ?? null }, by)
    const html = renderSlipDocument({ rows: [row], orders: [order], title: `Qimati packing slip ${row.order_name}`, printedBy: by, printedAt: row.printed_at, backHref: '/dispatch/print' })
    return new Response(html, { headers: SLIP_DOCUMENT_HEADERS })
  } catch (error) {
    if (error instanceof NotAuthorisedError) return new Response(error.message, { status: 401 })
    if (error instanceof NoSuchSlip) return text(error.message, 404)
    return text(slipShopifyError(error), 400)
  }
}
