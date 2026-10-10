import { requireOperator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { listOpenOrders, slipShopifyError } from '@/lib/shopify/slip-orders'
import { city, name, num, showPhone, units } from '@/lib/slips/plan'
import { select } from '@/lib/slips/print'
import { listBatches, printedOrderIds } from '@/lib/slips/store'
import { PrintScreen, type PreviewRow, type PrintBatch } from '@/components/slips/PrintScreen'

export const dynamic = 'force-dynamic'

export default async function PrintSlipsPage({ searchParams }: { searchParams: Promise<{ note?: string | string[] }> }) {
  await requireOperator()
  const { note } = await searchParams
  const problems: string[] = []
  let rows: PreviewRow[] = [], leftOut: string[] = [], unprinted = 0, truncated = false, oldest: number | null = null, batches: PrintBatch[] = []
  try {
    const selection = await select({ listOpenOrders: () => listOpenOrders(new ShopifyClient()), printedOrderIds }, null)
    rows = selection.rows.map(row => ({ id: row.order.id, number: num(row.order.name), name: row.order.name, mark: row.mark, detail: row.strip.detail, flags: row.strip.flags, how: row.strip.how, customer: name(row.order), phone: showPhone(row.order), city: city(row.order), units: units(row.order), status: row.order.fulfillmentStatus.replace(/_/g, ' ').toLowerCase() }))
    leftOut = selection.leftOut; unprinted = selection.unprinted; truncated = selection.truncated; oldest = rows[0]?.number ?? null
  } catch (cause) { problems.push(slipShopifyError(cause)) }
  try {
    batches = (await listBatches(12)).map(batch => ({ id: batch.id, printedBy: batch.printed_by, printedAt: batch.printed_at, count: batch.order_count, fromNumber: batch.from_number,
      first: batch.rows.find(row => row.mark !== 'BASELINE')?.order_number ?? null, last: [...batch.rows].reverse().find(row => row.mark !== 'BASELINE')?.order_number ?? null,
      baseline: batch.rows.filter(row => row.mark === 'BASELINE').length, failed: batch.rows.filter(row => row.progress === 'failed').map(row => ({ name: row.order_name, error: row.progress_error ?? '' })) }))
  } catch (cause) { problems.push(cause instanceof Error ? cause.message : 'Printed batches could not be loaded.') }
  return <PrintScreen rows={rows} leftOut={leftOut} unprinted={unprinted} truncated={truncated} oldest={oldest} batches={batches} note={typeof note === 'string' ? note : undefined} error={problems.join(' ') || undefined} />
}
