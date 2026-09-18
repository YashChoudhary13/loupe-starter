import Link from 'next/link'
import { requireOperator } from '@/lib/auth/authorize'
import { loadQcHistory, loadQcView } from '@/lib/qc/server'
import { qcShopifyError } from '@/lib/shopify/qc-orders'
import { QcScreen } from '@/components/qc/QcScreen'
import { QcHistoryScreen } from '@/components/qc/QcHistoryScreen'
import type { QcView } from '@/lib/qc/types'

export const dynamic = 'force-dynamic'
export default async function QcOrderPage({ params, searchParams }: { params: Promise<{ orderId: string }>; searchParams: Promise<{ view?: string }> }) {
  const operator = await requireOperator()
  const { orderId } = await params
  const { view: mode } = await searchParams
  if (mode === 'history') {
    let record: Awaited<ReturnType<typeof loadQcHistory>> = null
    let historyError: string | undefined
    try { record = await loadQcHistory(orderId) } catch (cause) { historyError = cause instanceof Error ? cause.message : 'QC history could not be loaded.' }
    if (!record) return <section className="p-6"><Link href="/qc" className="text-[13px] underline">← Order QC</Link><h1 className="mt-6 text-[26px] font-medium">No saved QC record</h1><p className="mt-4 max-w-2xl text-[13px] text-ink-soft">{historyError ?? 'This order has not been checked in Loupe.'}</p></section>
    return <QcHistoryScreen session={record.session} events={record.events} shortages={record.shortages} />
  }
  let view: QcView | undefined
  let error: string | undefined
  try { view = await loadQcView(orderId, operator) }
  catch (cause) { error = qcShopifyError(cause) }
  if (!view) return <section className="p-6"><Link href="/qc" className="text-[13px] underline">← Order QC</Link><h1 className="mt-6 text-[26px] font-medium">Could not open QC</h1><p role="alert" className="mt-4 max-w-2xl text-[13px] text-amber">{error}</p><Link href={`/qc/${encodeURIComponent(orderId)}`} className="mt-6 inline-block rounded-pill bg-ink px-5 py-3 text-[13px] text-white">Try again</Link></section>
  return <QcScreen key={view.order.id} initialView={view} />
}
