import Link from 'next/link'
import { requireOperator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { listQcOrders, qcShopifyError } from '@/lib/shopify/qc-orders'
import { qcOrderStatuses } from '@/lib/qc/server'

export const dynamic = 'force-dynamic'

export default async function QcOrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; after?: string }> }) {
  await requireOperator()
  const params = await searchParams
  const q = typeof params.q === 'string' ? params.q : ''
  const after = typeof params.after === 'string' ? params.after : null
  let result: Awaited<ReturnType<typeof listQcOrders>> | null = null
  let statuses: Awaited<ReturnType<typeof qcOrderStatuses>> = {}
  let error: string | undefined
  try {
    result = await listQcOrders(new ShopifyClient(), q, after)
    statuses = await qcOrderStatuses(result.nodes.map(order => order.id))
  } catch (cause) { error = qcShopifyError(cause) }
  return <section className="h-full overflow-auto px-4 py-6 md:px-8">
    <div className="flex flex-wrap items-start justify-between gap-4"><div>
      <h1 className="text-[26px] font-medium tracking-[-0.025em]">Order QC</h1>
      <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Open an order and scan every remaining shipping unit. Each colour and size is checked separately.</p>
    </div><Link href="/labels" className="rounded-pill bg-white px-5 py-3 text-[13px] focus-visible:outline-2">Prepare labels</Link></div>
    <form action="/qc" className="my-6 flex flex-wrap items-end gap-3">
      <label className="grid gap-2 text-[12px]">Shopify order number<input name="q" defaultValue={q} placeholder="Qimati5019" maxLength={60} className="rounded-pill bg-white px-4 py-3 text-[13px] focus:outline-2 focus:outline-ink" /></label>
      <button className="rounded-pill bg-ink px-6 py-3 text-[13px] text-white focus-visible:outline-2 focus-visible:outline-offset-2">Find order</button>
      {q && <Link href="/qc" className="rounded-pill px-4 py-3 text-[13px] underline">All open orders</Link>}
    </form>
    {error && <p role="alert" className="mb-4 rounded-panel bg-white p-4 text-[13px] text-amber">{error}</p>}
    <div className="rounded-card bg-surface p-4 md:p-6">
      <div className="mb-4 flex flex-wrap justify-between gap-2"><h2 className="text-[15px] font-medium">Orders awaiting fulfillment</h2><span className="text-[12px] text-ink-soft">QC status is verified again when you open an order</span></div>
      {result?.nodes.length === 0 && <p className="py-8 text-[13px] text-ink-soft">No matching open orders awaiting fulfillment.</p>}
      <div className="grid gap-3">{result?.nodes.map(order => {
        const saved = statuses[order.id]
        const label = saved?.status === 'passed' ? 'Previously passed · recheck' : saved?.status === 'stale' ? 'Order changed · recount' : saved ? 'QC in progress' : 'Not checked'
        return <Link key={order.id} href={`/qc/${order.id.split('/').pop()}`} className="flex flex-wrap items-center justify-between gap-4 rounded-panel border border-chip p-4 hover:border-ink focus-visible:outline-2 focus-visible:outline-ink">
          <div><div className="text-[16px] font-medium">{order.name}</div><div className="mt-1 text-[12px] text-ink-soft">{new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })} · {order.displayFulfillmentStatus.toLowerCase().replaceAll('_', ' ')}</div></div>
          <div className="flex items-center gap-4 text-[12px]"><span className="rounded-pill bg-chip px-3 py-2">{label}</span><span>Open QC →</span></div>
        </Link>
      })}</div>
      <div className="mt-5 flex justify-between text-[13px]">{after ? <Link href={`/qc?q=${encodeURIComponent(q)}`} className="rounded-pill bg-chip px-4 py-2">First page</Link> : <span />}{result?.pageInfo.hasNextPage && <Link href={`/qc?q=${encodeURIComponent(q)}&after=${encodeURIComponent(result.pageInfo.endCursor!)}`} className="rounded-pill bg-ink px-4 py-2 text-white">More orders →</Link>}</div>
    </div>
    <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-ink-soft">This checklist covers all remaining shipping units in the order, including units assigned to other locations. Use it when checking the whole remaining order together. One scan counts one saleable unit (for example, one pair or one set). QC completion does not fulfill the order in Shopify.</p>
  </section>
}
