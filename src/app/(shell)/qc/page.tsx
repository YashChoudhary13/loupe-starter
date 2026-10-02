import Link from 'next/link'
import { requireOperator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { listQcOrders, qcShopifyError } from '@/lib/shopify/qc-orders'
import { listRecentPasses, qcOrderStatuses } from '@/lib/qc/server'
import type { QcPass } from '@/lib/qc/types'

export const dynamic = 'force-dynamic'
const day = (value: string) => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const clock = (value: string) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const orderPath = (gid: string) => `/qc/${gid.split('/').pop()}`

export default async function QcOrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; after?: string }> }) {
  await requireOperator()
  const params = await searchParams
  const q = typeof params.q === 'string' ? params.q : ''
  const after = typeof params.after === 'string' ? params.after : null
  let result: Awaited<ReturnType<typeof listQcOrders>> | null = null
  let statuses: Awaited<ReturnType<typeof qcOrderStatuses>> = {}
  let error: string | undefined
  let passes: QcPass[] = []
  let passesError: string | undefined
  try {
    result = await listQcOrders(new ShopifyClient(), q, after)
    statuses = await qcOrderStatuses(result.nodes.map(order => order.id))
  } catch (cause) { error = qcShopifyError(cause) }
  try { passes = await listRecentPasses(30) } catch (cause) { passesError = cause instanceof Error ? cause.message : 'Past QC checks could not be loaded.' }
  const orders = result?.nodes ?? []
  const toCheck = orders.filter(order => statuses[order.id]?.status !== 'passed')
  const checked = orders.filter(order => statuses[order.id]?.status === 'passed')
  const passByOrder = new Map(passes.map(pass => [pass.orderId, pass]))
  const scope = after || result?.pageInfo.hasNextPage ? 'on this page' : 'open orders'

  function row(order: typeof orders[number], passed: boolean) {
    const saved = statuses[order.id]
    const status = saved?.status === 'stale' ? 'Recount needed' : saved ? 'In progress' : 'Not checked'
    const statusClass = saved?.status === 'stale' ? 'bg-amber text-black' : saved ? 'bg-ink text-white' : 'bg-line text-ink'
    const held = order.displayFulfillmentStatus === 'ON_HOLD'
    const short = passed ? passByOrder.get(order.id)?.short : undefined
    return <Link key={order.id} href={orderPath(order.id)} className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-white p-4 focus-visible:outline-2 focus-visible:outline-ink">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-[20px] font-medium">{order.name}{held && <span className="rounded-pill bg-amber px-2.5 py-1 text-[15px] font-semibold text-black">Hold</span>}</div><p className="mt-1 text-[15px] text-ink-soft">{day(order.createdAt)} · {order.displayFinancialStatus.toLowerCase().replaceAll('_', ' ')}</p></div>
      <div className="flex flex-wrap items-center gap-2 text-[15px]"><span className={`rounded-pill px-3 py-2 font-medium ${passed ? 'bg-green text-white' : statusClass}`}>{passed ? held ? 'HOLD box' : 'Ready to ship' : status}</span>{short !== undefined && short > 0 && <span className="rounded-pill bg-chip px-3 py-2">{short} short</span>}<span aria-hidden="true">→</span></div>
    </Link>
  }

  return <section className="h-full min-w-0 overflow-auto px-1 py-2 md:px-3 md:py-3" aria-label="Order QC orders">
    <div className="flex flex-wrap items-start justify-between gap-4"><div>
      <h1 className="text-[28px] font-medium tracking-[-0.025em]">Order QC</h1>
      <p className="mt-1 text-[15px] text-ink-soft">Choose a paid order. Check each pouch before it goes in the box.</p>
    </div><div className="flex flex-wrap gap-2"><Link href="/qc/shortages" className="inline-flex min-h-11 items-center rounded-pill bg-white px-4 py-2 text-[15px] focus-visible:outline-2">Shortages</Link><Link href="/labels" className="inline-flex min-h-11 items-center rounded-pill bg-white px-4 py-2 text-[15px] focus-visible:outline-2">Prepare labels</Link></div></div>
    <form action="/qc" className="my-5 flex flex-wrap items-end gap-3">
      <label className="grid min-w-0 gap-2 text-[15px]">Shopify order number<input name="q" defaultValue={q} placeholder="Qimati5019" maxLength={60} className="min-h-11 min-w-0 rounded-pill bg-white px-4 py-3 text-[16px] focus:outline-2 focus:outline-ink" /></label>
      <button className="min-h-11 rounded-pill bg-ink px-5 py-3 text-[15px] text-white focus-visible:outline-2 focus-visible:outline-offset-2">Find order</button>
      {q && <Link href="/qc" className="inline-flex min-h-11 items-center rounded-pill px-3 py-2 text-[15px] underline">All open orders</Link>}
    </form>
    <p className="mb-4 text-[15px] text-ink-soft">{q ? 'A searched order is shown whatever its payment status.' : 'Payment-pending orders are hidden until paid.'} Saved QC status is verified again when an order opens.</p>
    {error && <p role="alert" className="mb-4 rounded-panel bg-amber p-4 text-[16px] text-black">{error}</p>}
    {!error && <div className="grid items-start gap-4 md:grid-cols-2">
      <section aria-labelledby="qc-to-check" className="min-w-0 rounded-card bg-surface p-3 md:p-4"><div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h2 id="qc-to-check" className="text-[22px] font-medium">To check · {toCheck.length}</h2><span className="text-[15px] text-ink-soft">{scope}</span></div><div className="space-y-3">{toCheck.map(order => row(order, false))}</div>{toCheck.length === 0 && <p className="py-5 text-[15px] text-ink-soft">No orders to check {scope === 'on this page' ? 'on this page' : 'in this list'}.</p>}</section>
      <section aria-labelledby="qc-checked" className="min-w-0 rounded-card border border-green/30 bg-surface p-3 md:p-4"><div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h2 id="qc-checked" className="text-[22px] font-medium text-green">Checked · {checked.length}</h2><span className="text-[15px] text-ink-soft">{scope}</span></div><div className="space-y-3">{checked.map(order => row(order, true))}</div>{checked.length === 0 && <p className="py-5 text-[15px] text-ink-soft">No checked orders {scope === 'on this page' ? 'on this page' : 'in this list'}.</p>}</section>
    </div>}
    <div className="mt-4 flex justify-between text-[15px]">{after ? <Link href={`/qc?q=${encodeURIComponent(q)}`} className="inline-flex min-h-11 items-center rounded-pill bg-chip px-4 py-2">First page</Link> : <span />}{result?.pageInfo.hasNextPage && <Link href={`/qc?q=${encodeURIComponent(q)}&after=${encodeURIComponent(result.pageInfo.endCursor!)}`} className="inline-flex min-h-11 items-center rounded-pill bg-ink px-4 py-2 text-white">More orders →</Link>}</div>
    <details className="mt-5 rounded-card bg-surface p-4">
      <summary className="min-h-11 cursor-pointer content-center rounded-pill text-[18px] font-medium">Checked in the last 30 days · {passes.length}</summary>
      <p className="my-3 text-[15px] text-ink-soft">Saved records; opening one does not re-read Shopify.</p>
      {passesError && <p role="alert" className="rounded-panel bg-amber p-3 text-[16px] text-black">{passesError}</p>}
      {!passesError && passes.length === 0 && <p className="py-4 text-[15px] text-ink-soft">No QC has passed in the last 30 days.</p>}
      <div className="space-y-2">{passes.map(pass => <Link key={pass.orderId} href={`${orderPath(pass.orderId)}?view=history`} className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-white p-4 focus-visible:outline-2 focus-visible:outline-ink">
        <div><span className="text-[18px] font-medium">{pass.orderName}</span><p className="mt-1 text-[15px] text-ink-soft">{day(pass.passedAt)} {clock(pass.passedAt)} · {pass.passedBy}</p></div>
        <div className="flex flex-wrap items-center gap-3 text-[15px]"><span>{pass.units} unit{pass.units === 1 ? '' : 's'}</span>{pass.short > 0 && <span className="rounded-pill bg-chip px-3 py-1">{pass.short} short</span>}{pass.sessionStatus === 'stale' && <span className="rounded-pill bg-chip px-3 py-1">changed since</span>}<span>Record →</span></div>
      </Link>)}</div>
    </details>
    <p className="mt-4 text-[15px] text-ink-soft">One scan checks one saleable unit. QC completion does not fulfil the order in Shopify.</p>
  </section>
}
