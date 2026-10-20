import { actorFor, NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { readLabelForm } from '@/lib/labels/form'
import { renderLabelTspl } from '@/lib/labels/tspl'
import { readLabelVariants, verifyLabelCodes } from '@/lib/labels/catalogue'
import { RelayError, relaySend } from '@/lib/print-relay/client'
import { ShopifyClient } from '@/lib/shopify/client'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const text = (message: string, status: number) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
const esc = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/**
 * D157: the same label selection as /api/labels/print, printed on the office label printer through the relay instead of
 * this browser. Answers JSON to a fetch and a small page to a plain form post (the Labels screen's second button).
 * 501 means the relay is not configured; the console then falls back to the browser's print dialog.
 */
export async function POST(request: Request) {
  const wantsPage = (request.headers.get('accept') ?? '').includes('text/html')
  try {
    const by = actorFor(await requireOperatorForAction())
    if (!isOwnOrigin(request.headers.get('origin'))) return text('Open Labels in Loupe before printing.', 403)
    const selection = await readLabelForm(request)
    if (selection instanceof Response) return selection
    const client = new ShopifyClient()
    const variants = await readLabelVariants(client, selection.items.map(item => item.id))
    await verifyLabelCodes(client, variants)
    const { tspl, labels } = renderLabelTspl(selection.items, variants)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const job = await relaySend({ filename: `labels-${stamp}.tspl`, body: tspl, uploader: by })
    await supabaseServer().from('events').insert({ entity_type: 'system', entity_id: null, event: 'labels.office_print', detail: { relay_job: job.id, labels, variants: selection.items.map(item => ({ id: item.id, copies: item.copies })) }, actor: by })
    const message = `${labels} label${labels === 1 ? '' : 's'} sent to the office label printer.`
    if (wantsPage) return new Response(`<!doctype html><meta charset="utf-8"><title>Labels sent</title><body style="font:15px/1.5 system-ui;padding:32px"><p>${esc(message)}</p><p><a href="/labels">Back to Labels</a></p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
    return Response.json({ ok: true, jobId: job.id, labels, message })
  } catch (error) {
    if (error instanceof NotAuthorisedError) return text(error.message, 401)
    if (error instanceof RelayError) return text(error.message, error.status === 501 ? 501 : 503)
    return text(error instanceof Error ? error.message : 'Could not prepare labels. Return to Labels and retry.', 400)
  }
}
