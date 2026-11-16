import { requireOperatorWith } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { listOpenOrders, slipShopifyError } from '@/lib/shopify/slip-orders'
import { city, name, num, showPhone, units } from '@/lib/slips/plan'
import { select } from '@/lib/slips/print'
import { autoDue, istClock, istMinutes } from '@/lib/slips/auto'
import { listBatches, printedOrderIds } from '@/lib/slips/store'
import { PrintScreen, type PreviewRow, type PrintBatch } from '@/components/slips/PrintScreen'

export const dynamic = 'force-dynamic'

export default async function PrintSlipsPage({ searchParams }: { searchParams: Promise<{ auto?: string | string[] }> }) {
  const auto = (await searchParams).auto !== undefined ? { due: autoDue(istMinutes()), readAt: istClock() } : null // ?auto: print new orders as they come, the server's clock decides (lib/slips/auto.ts)
  const problems: string[] = []
  let rows: PreviewRow[] = [], leftOut: string[] = [], unprinted = 0, truncated = false, oldest: number | null = null, batches: PrintBatch[] = []
  // The orders to print and the batches already printed do not depend on each other: read together, with the sign-in check (D174).
  const [picked, printed] = await requireOperatorWith(() => Promise.allSettled([select({ listOpenOrders: () => listOpenOrders(new ShopifyClient()), printedOrderIds }, null), listBatches(12)]),
    auto ? '/dispatch/print?auto' : undefined) // the office PC signs in each morning and must land back here
  if (picked.status === 'fulfilled') {
    const selection = picked.value
    rows = selection.rows.map(row => ({ id: row.order.id, number: num(row.order.name), name: row.order.name, mark: row.mark, detail: row.strip.detail, flags: row.strip.flags, how: row.strip.how, customer: name(row.order), phone: showPhone(row.order), city: city(row.order), units: units(row.order), status: row.order.fulfillmentStatus.replace(/_/g, ' ').toLowerCase() }))
    leftOut = selection.leftOut; unprinted = selection.unprinted; truncated = selection.truncated; oldest = rows[0]?.number ?? null
  } else problems.push(slipShopifyError(picked.reason))
  if (printed.status === 'fulfilled') {
    batches = printed.value.map(batch => ({ id: batch.id, printedBy: batch.printed_by, printedAt: batch.printed_at, count: batch.order_count, fromNumber: batch.from_number,
      first: batch.rows.find(row => row.mark !== 'BASELINE')?.order_number ?? null, last: [...batch.rows].reverse().find(row => row.mark !== 'BASELINE')?.order_number ?? null,
      baseline: batch.rows.filter(row => row.mark === 'BASELINE').length, failed: batch.rows.filter(row => row.progress === 'failed').map(row => ({ name: row.order_name, error: row.progress_error ?? '' })) }))
  } else problems.push(printed.reason instanceof Error ? printed.reason.message : 'Printed batches could not be loaded.')
  return <PrintScreen rows={rows} leftOut={leftOut} unprinted={unprinted} truncated={truncated} oldest={oldest} batches={batches} error={problems.join(' ') || undefined} auto={auto} />
}
