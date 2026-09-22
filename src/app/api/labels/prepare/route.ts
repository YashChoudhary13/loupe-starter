import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { isOwnOrigin } from '@/lib/faces/server'
import { supabaseServer } from '@/lib/supabase/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { applyProductCodes, planProductCodes } from '@/lib/labels/prepare-codes'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: Request) {
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  try {
    const operator = await requireOperatorForAction()
    if (!isOwnOrigin(request.headers.get('origin'))) return reply({ error: 'Open Labels in Loupe first.' }, 403)
    if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Use the Labels form.' }, 415)
    const reader = request.body?.getReader()
    let raw = ''; let bytes = 0
    const decoder = new TextDecoder()
    if (!reader) return reply({ error: 'No product selected.' }, 400)
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4096) { await reader.cancel(); return reply({ error: 'Request too large.' }, 413) }
      raw += decoder.decode(chunk.value, { stream: true })
    }
    raw += decoder.decode()
    const input = JSON.parse(raw) as { action?: unknown; productId?: unknown; fingerprint?: unknown }
    if (!['preview', 'apply'].includes(String(input.action)) || typeof input.productId !== 'string') return reply({ error: 'Choose a product and preview its codes.' }, 400)
    const db = supabaseServer()
    const { data: draft, error } = await db.from('product_drafts').select('status').eq('shopify_product_id', input.productId).neq('status', 'published').limit(1)
    if (error) throw new Error('Could not check the Loupe draft. Retry shortly.')
    if (draft?.length) throw new Error('Finish publishing this Loupe draft before preparing its codes. Its draft editor controls the current identifiers.')
    const client = new ShopifyClient()
    const plan = await planProductCodes(client, input.productId)
    if (input.action === 'preview') return reply({ plan })
    if (input.fingerprint !== plan.fingerprint) return reply({ error: 'The product changed after your preview. Preview its current codes again.' }, 409)
    const audit = await db.from('events').insert({ entity_type: 'system', entity_id: null, event: 'labels.codes_preparing', actor: operator.email, detail: plan })
    if (audit.error) throw new Error('Could not record the code change. Nothing has been written to Shopify; try again.')
    await applyProductCodes(client, plan)
    const recorded = await db.from('events').insert({ entity_type: 'system', entity_id: null, event: 'labels.codes_prepared', actor: operator.email, detail: { productId: plan.productId, fingerprint: plan.fingerprint, rows: plan.rows } })
    if (recorded.error) throw new Error('Shopify saved the codes but the completion log failed. Reload Labels to see the saved codes.')
    return reply({ saved: true, parent: plan.parent })
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : 'Could not prepare codes.' }, error instanceof NotAuthorisedError ? 401 : 400)
  }
}
