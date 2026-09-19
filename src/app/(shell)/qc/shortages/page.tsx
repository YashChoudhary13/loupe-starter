import Link from 'next/link'
import { requireOperator } from '@/lib/auth/authorize'
import { listShortages } from '@/lib/qc/shortages'
import { ShortageResolveForm } from '@/components/qc/ShortageResolveForm'
import type { QcShortage } from '@/lib/qc/types'

export const dynamic = 'force-dynamic'
const when = (value: string) => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const orderPath = (gid: string) => `/qc/${gid.split('/').pop()}?view=history`

function Row({ item }: { item: QcShortage }) {
  return <article className={`rounded-panel border bg-white p-4 ${item.resolved_at ? 'border-chip' : 'border-amber'}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[14px] font-medium">#{item.ref} · <Link href={orderPath(item.order_id)} className="underline">{item.order_name}</Link> · {item.title}{item.variant_title && <span className="text-ink-soft"> · {item.variant_title}</span>}</p>
        <p className="mt-1 text-[13px]"><span className="font-medium text-amber">{item.quantity} short</span> · <span className="font-mono text-[12px]">{item.sku ?? 'no code'}</span> · {item.reason}</p>
        <p className="mt-1 text-[12px] text-ink-soft">Reported {when(item.reported_at)} by {item.reported_by}{item.resolved_at && ` · Resolved ${when(item.resolved_at)} · ${item.resolution} by ${item.resolved_by}${item.resolution_note ? ` · ${item.resolution_note}` : ''}`}</p>
      </div>
      {!item.resolved_at && <ShortageResolveForm shortageRef={item.ref} />}
    </div>
  </article>
}

export default async function ShortagesPage() {
  await requireOperator()
  let lists: Awaited<ReturnType<typeof listShortages>> = { open: [], resolved: [] }
  let error: string | undefined
  try { lists = await listShortages(30) } catch (cause) { error = cause instanceof Error ? cause.message : 'Shortages could not be loaded.' }
  return <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div>
      <h1 className="text-[26px] font-medium tracking-[-0.025em]">Shortages</h1>
      <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Units marked short during QC because the team did not have them. Each stays open until the customer is refunded, sent a coupon, or the unit is shipped later. Staff can also list and resolve these from WhatsApp with <span className="font-mono">missing</span>.</p>
    </div><Link href="/qc" className="rounded-pill bg-white px-5 py-3 text-[13px] focus-visible:outline-2">← Order QC</Link></div>
    {error && <p role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">{error}</p>}
    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <h2 className="mb-4 text-[15px] font-medium">Open · {lists.open.length}</h2>
      {lists.open.length === 0 && !error && <p className="py-4 text-[13px] text-ink-soft">Nothing is short. Every checked order had all its units.</p>}
      <div className="grid gap-3">{lists.open.map(item => <Row key={item.id} item={item} />)}</div>
    </div>
    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <h2 className="mb-4 text-[15px] font-medium">Resolved in the last 30 days · {lists.resolved.length}</h2>
      {lists.resolved.length === 0 && !error && <p className="py-4 text-[13px] text-ink-soft">No shortages were resolved in the last 30 days.</p>}
      <div className="grid gap-3">{lists.resolved.map(item => <Row key={item.id} item={item} />)}</div>
    </div>
  </section>
}
