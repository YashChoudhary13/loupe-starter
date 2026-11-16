import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import type { PhotoKind } from '@/lib/find/query'
import { photoObject } from '@/lib/find/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const KINDS: readonly PhotoKind[] = ['parcel', 'phone', 'original']

/**
 * Find (D173): one full photograph, served from Loupe's own host to a signed-in operator. A signed storage link is a
 * new address every time, so the browser would download the same photograph again on every look-up and could not
 * draw it on a canvas (Copy picture). This address is stable: the second look at an order is instant, for a day.
 * The photograph is named by its row, never by a storage key.
 */
export async function GET(request: Request) {
  try {
    await requireOperatorForAction()
    const params = new URL(request.url).searchParams
    const kind = params.get('kind') as PhotoKind
    if (!KINDS.includes(kind)) return new Response('Unknown photo.', { status: 400 })
    const photo = await photoObject(kind, params.get('id') ?? '')
    const download = (params.get('download') ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
    return new Response(new Uint8Array(photo.bytes), { headers: {
      'Content-Type': photo.contentType,
      'Content-Length': String(photo.bytes.length),
      // private: a parcel photograph shows a buyer's address, so no shared cache may keep it.
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      ...(download ? { 'Content-Disposition': `attachment; filename="${download}.${photo.extension}"` } : {}),
    } })
  } catch (cause) {
    if (cause instanceof NotAuthorisedError) return new Response(cause.message, { status: 401 })
    if (cause instanceof ConsoleError) return new Response(cause.operatorMessage, { status: cause.retryable ? 503 : 404 })
    console.error('find photo failed:', cause instanceof Error ? cause.message : String(cause))
    return new Response('That photo could not be loaded.', { status: 500 })
  }
}
