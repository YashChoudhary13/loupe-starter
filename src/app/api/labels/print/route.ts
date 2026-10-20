import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { readLabelVariants, verifyLabelCodes } from '@/lib/labels/catalogue'
import { readLabelForm } from '@/lib/labels/form'
import { renderLabelDocument } from '@/lib/labels/print'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: Request) {
  try {
    await requireOperatorForAction()
    if (!isOwnOrigin(request.headers.get('origin'))) return new Response('Open Labels in Loupe before printing.', { status: 403 })
    const selection = await readLabelForm(request)
    if (selection instanceof Response) return selection
    const client = new ShopifyClient()
    const variants = await readLabelVariants(client, selection.items.map(item => item.id))
    await verifyLabelCodes(client, variants)
    return new Response(renderLabelDocument(selection, variants), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' },
    })
  } catch (error) {
    if (error instanceof NotAuthorisedError) return new Response(error.message, { status: 401 })
    return new Response(error instanceof Error ? error.message : 'Could not prepare labels. Return to Labels and retry.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
}
