import 'server-only'
import { supabaseServer } from '@/lib/supabase/server'
import { ShopifyClient } from '@/lib/shopify/client'
import type { NewPrintRow } from './print'
import type { Progress, SlipBatchRow, SlipPrintRow } from './types'

const ROW_FIELDS = 'id,batch_id,order_id,order_name,order_number,mark,strip,progress,progress_error,printed_at'
const BATCH_FIELDS = `id,printed_by,printed_at,order_count,from_number,rows:slip_prints(${ROW_FIELDS})`
const READ_FAILED = 'Printed slips could not be read. Reload and try again.'
const shop = () => new ShopifyClient().config.storeDomain
const sorted = (batch: SlipBatchRow): SlipBatchRow => ({ ...batch, rows: [...batch.rows].sort((a, b) => a.order_number - b.order_number) })

export async function printedOrderIds(ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let start = 0; start < ids.length; start += 200) {
    const { data, error } = await supabaseServer().from('slip_prints').select('order_id').eq('shop_domain', shop()).in('order_id', ids.slice(start, start + 200))
    if (error) throw new Error(READ_FAILED)
    for (const row of data ?? []) found.add(row.order_id as string)
  }
  return found
}
export async function createBatch(input: { by: string; fromNumber: number | null }): Promise<string> {
  const { data, error } = await supabaseServer().from('slip_batches').insert({ shop_domain: shop(), printed_by: input.by, from_number: input.fromNumber }).select('id').single()
  if (error || !data) throw new Error('The print could not be recorded, so nothing was printed. Try again.')
  return data.id as string
}
/** `ignoreDuplicates` is Postgres `on conflict do nothing`, and `returning` lists only the rows that went in. */
export async function insertRows(batchId: string, rows: readonly NewPrintRow[]): Promise<Set<string>> {
  if (!rows.length) return new Set()
  const { data, error } = await supabaseServer().from('slip_prints')
    .upsert(rows.map(row => ({ batch_id: batchId, shop_domain: shop(), order_id: row.orderId, order_name: row.orderName, order_number: row.orderNumber, mark: row.mark, strip: row.strip })), { onConflict: 'shop_domain,order_id', ignoreDuplicates: true })
    .select('order_id')
  if (error) throw new Error('The printed orders could not be recorded, so nothing was printed. Try again.')
  return new Set((data ?? []).map(row => row.order_id as string))
}
export async function finishBatch(batchId: string, orderCount: number): Promise<void> {
  const { error } = await supabaseServer().from('slip_batches').update({ order_count: orderCount }).eq('id', batchId)
  if (error) console.error('slip batch count not saved', error)
}
export async function setProgress(batchId: string, orderId: string, progress: Progress, progressError: string | null): Promise<void> {
  const { error } = await supabaseServer().from('slip_prints').update({ progress, progress_error: progressError }).eq('batch_id', batchId).eq('order_id', orderId)
  if (error) console.error('slip progress not saved', error)
}
export async function record(batchId: string, event: string, detail: Record<string, unknown>, by: string): Promise<void> {
  const { error } = await supabaseServer().from('events').insert({ entity_type: 'slip_batch', entity_id: batchId, event, detail, actor: by })
  if (error) console.error('slip audit record not written', error)
}
export async function listBatches(limit: number): Promise<SlipBatchRow[]> {
  const { data, error } = await supabaseServer().from('slip_batches').select(BATCH_FIELDS).eq('shop_domain', shop()).order('printed_at', { ascending: false }).limit(limit)
  if (error) throw new Error(READ_FAILED)
  return ((data ?? []) as unknown as SlipBatchRow[]).map(sorted)
}
export async function loadBatch(batchId: string): Promise<SlipBatchRow | null> {
  const { data, error } = await supabaseServer().from('slip_batches').select(BATCH_FIELDS).eq('shop_domain', shop()).eq('id', batchId).maybeSingle()
  if (error) throw new Error(READ_FAILED)
  return data ? sorted(data as unknown as SlipBatchRow) : null
}
export type { SlipPrintRow }
