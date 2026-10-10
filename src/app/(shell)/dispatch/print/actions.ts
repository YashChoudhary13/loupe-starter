'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, requireOperatorForAction } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { readOrders, reportProgress, slipShopifyError } from '@/lib/shopify/slip-orders'
import { retryProgress } from '@/lib/slips/print'
import { loadBatch, record, setProgress } from '@/lib/slips/store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Marks In progress again every order of a batch whose write failed. The actor comes from the session, never from the browser. */
export async function retryProgressAction(batchId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const by = actorFor(await requireOperatorForAction())
    if (!UUID.test(String(batchId))) throw new Error('Reload Print slips and try again.')
    const batch = await loadBatch(batchId)
    if (!batch) throw new Error('This batch no longer exists. Reload Print slips.')
    const client = new ShopifyClient()
    const result = await retryProgress(batchId, batch.rows, by, { readOrders: ids => readOrders(client, ids), setProgress, record, reportProgress: (id, note) => reportProgress(client, id, note).then(() => undefined) })
    revalidatePath('/dispatch/print')
    return { ok: result.failed.length === 0, message: result.failed.length ? `${result.fixed} marked; still failing: ${result.failed.map(item => `${item.name} (${item.error})`).join('; ')}` : result.fixed ? `${result.fixed} order${result.fixed === 1 ? '' : 's'} marked In progress.` : 'Nothing to retry.' }
  } catch (cause) { return { ok: false, message: slipShopifyError(cause) } }
}
