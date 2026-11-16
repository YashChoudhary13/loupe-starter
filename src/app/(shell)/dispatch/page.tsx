import { requireOperatorWith } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { dispatchShopifyError, listDispatchOrders } from '@/lib/shopify/dispatch-orders'
import { qcOrderStatuses } from '@/lib/qc/server'
import { listParcels } from '@/lib/dispatch/store'
import { DispatchScreen } from '@/components/dispatch/DispatchScreen'
import type { DispatchOrderSummary, ParcelRow } from '@/lib/dispatch/types'

export const dynamic = 'force-dynamic'

export default async function DispatchPage() {
  let orders: DispatchOrderSummary[] = [], truncated = false, open: ParcelRow[] = [], recent: ParcelRow[] = [], ordersLoaded = false
  const problems: string[] = []
  // Shopify's orders and the staged numbers do not depend on each other, so they are read together (D171), and the
  // sign-in check goes out with them (D174).
  const [listed, staged] = await requireOperatorWith(() => Promise.allSettled([listDispatchOrders(new ShopifyClient()), listParcels(30)]))
  if (listed.status === 'fulfilled') { ({ orders, truncated } = listed.value); ordersLoaded = true } else problems.push(dispatchShopifyError(listed.reason))
  if (staged.status === 'fulfilled') ({ open, recent } = staged.value); else problems.push(staged.reason instanceof Error ? staged.reason.message : 'Staged numbers could not be loaded.')
  const ids = [...new Set([...orders.map(order => order.id), ...open.flatMap(parcel => parcel.orders.map(item => item.order_id))])]
  let qcPassed: Record<string, boolean> = {}
  try { const statuses = await qcOrderStatuses(ids); qcPassed = Object.fromEntries(ids.map(id => [id, statuses[id]?.status === 'passed'])) }
  catch { problems.push('QC status could not be loaded, so every QC badge shows as not checked.') }
  // A truncated list is not a loaded list: an order past the 300-order cut is missing, not gone, so it must
  // never be offered for discard.
  return <DispatchScreen orders={orders} qcPassed={qcPassed} open={open} recent={recent} truncated={truncated} ordersLoaded={ordersLoaded && !truncated} error={problems.join(' ') || undefined} />
}
