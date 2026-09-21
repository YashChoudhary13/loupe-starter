import { requireOperator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { dispatchShopifyError, listDispatchOrders } from '@/lib/shopify/dispatch-orders'
import { qcOrderStatuses } from '@/lib/qc/server'
import { listParcels } from '@/lib/dispatch/store'
import { DispatchScreen } from '@/components/dispatch/DispatchScreen'
import type { DispatchOrderSummary, ParcelRow } from '@/lib/dispatch/types'

export const dynamic = 'force-dynamic'

export default async function DispatchPage() {
  await requireOperator()
  let orders: DispatchOrderSummary[] = [], truncated = false, open: ParcelRow[] = [], recent: ParcelRow[] = [], ordersLoaded = false
  const problems: string[] = []
  try { ({ orders, truncated } = await listDispatchOrders(new ShopifyClient())); ordersLoaded = true } catch (cause) { problems.push(dispatchShopifyError(cause)) }
  try { ({ open, recent } = await listParcels(30)) } catch (cause) { problems.push(cause instanceof Error ? cause.message : 'Staged numbers could not be loaded.') }
  const ids = [...new Set([...orders.map(order => order.id), ...open.flatMap(parcel => parcel.orders.map(item => item.order_id))])]
  let qcPassed: Record<string, boolean> = {}
  try { const statuses = await qcOrderStatuses(ids); qcPassed = Object.fromEntries(ids.map(id => [id, statuses[id]?.status === 'passed'])) }
  catch { problems.push('QC status could not be loaded, so every QC badge shows as not checked.') }
  return <DispatchScreen orders={orders} qcPassed={qcPassed} open={open} recent={recent} truncated={truncated} ordersLoaded={ordersLoaded} error={problems.join(' ') || undefined} />
}
