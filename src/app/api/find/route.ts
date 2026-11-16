import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import { isOwnOrigin } from '@/lib/faces/server'
import { orderNumbersFrom, parseQuery } from '@/lib/find/query'
import { beginParcelUpload, confirmParcel, dismissParcel, finishParcelUpload, listParcels, orderLive, searchFind } from '@/lib/find/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * Find (D173). Fetches of a route, not server actions: a server action waits for the one before it, and the support
 * desk types the next order while the last answer is still on its way. The screen cancels a request it no longer wants.
 *
 *   GET ?q=8524 | ?q=RS514   photographs, from the database only
 *   GET ?order=8524          that order's tracking, asked of Shopify now
 *   GET ?parcels=1           the photographs waiting for a person, and the latest ones
 *   POST {op: begin | finish | confirm | dismiss}   one parcel photograph
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const problem = (message: string, status: number, detail: string | null = null, retryable = false) => json({ error: { message, detail, retryable } }, status)

function failed(cause: unknown): Response {
  if (cause instanceof NotAuthorisedError) return problem(cause.message, 401)
  if (cause instanceof ConsoleError) return problem(cause.operatorMessage, cause.retryable ? 503 : 400, cause.detail, cause.retryable)
  console.error('find failed:', cause instanceof Error ? cause.message : String(cause))
  return problem('That did not work. Try again.', 500, cause instanceof Error ? cause.message : null, true)
}

export async function GET(request: Request) {
  try {
    await requireOperatorForAction()
    const params = new URL(request.url).searchParams
    if (params.has('parcels')) return json(await listParcels())
    const order = params.get('order')
    if (order !== null) {
      if (!/^[1-9]\d{0,7}$/.test(order)) return problem('That order number does not look right.', 400)
      return json(await orderLive(Number(order)))
    }
    const query = parseQuery(params.get('q') ?? '')
    if (!query) return problem('Type an order number or a product code.', 400)
    return json(await searchFind(query))
  } catch (cause) {
    return failed(cause)
  }
}

export async function POST(request: Request) {
  try {
    const operator = await requireOperatorForAction()
    if (!isOwnOrigin(request.headers.get('origin'))) return problem('Open Find in Loupe first.', 403)
    const body = await request.json().catch(() => null) as { op?: unknown; id?: unknown; filename?: unknown; mimeType?: unknown; bytes?: unknown; orders?: unknown } | null
    const id = typeof body?.id === 'string' ? body.id : ''
    switch (body?.op) {
      case 'begin': return json(await beginParcelUpload(operator, { filename: String(body.filename ?? ''), mimeType: String(body.mimeType ?? ''), bytes: Number(body.bytes) }))
      case 'finish': return json(await finishParcelUpload(operator, id))
      case 'confirm': return json(await confirmParcel(operator, id, orderNumbersFrom(String(body.orders ?? ''))))
      case 'dismiss': return json(await dismissParcel(operator, id))
      default: return problem('Use the Find page.', 400)
    }
  } catch (cause) {
    return failed(cause)
  }
}
