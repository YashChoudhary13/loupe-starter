import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { ShopifyClient } from '@/lib/shopify/client'
import { readLabelVariants, verifyLabelCodes } from '@/lib/labels/catalogue'
import { parseLabelRequest, renderLabelDocument } from '@/lib/labels/print'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(request: Request) {
  try {
    await requireOperatorForAction()
    if (request.headers.get('origin') !== new URL(serverEnv.authBaseUrl).origin) return new Response('Open Labels in Loupe before printing.', { status: 403 })
    if (Number(request.headers.get('content-length') ?? '0') > 32000) return new Response('Print selection too large.', { status: 413 })
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return new Response('Use the label selection form.', { status: 415 })
    const reader = request.body?.getReader()
    if (!reader) return new Response('No labels selected.', { status: 400 })
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 32000) { await reader.cancel(); return new Response('Print selection too large.', { status: 413 }) }
      chunks.push(value)
    }
    const form = new FormData()
    for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) form.append(key, value)
    const selection = parseLabelRequest(form)
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
