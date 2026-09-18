import Link from 'next/link'
import type { QcEvent, QcSession, QcShortage } from '@/lib/qc/types'

const when = (value: string) => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** Read-only record of a saved checklist. Server component: no Shopify read, no RPC, nothing can be invalidated by looking. */
export function QcHistoryScreen({ session, events, shortages }: { session: QcSession; events: QcEvent[]; shortages: QcShortage[] }) {
  const pass = events.find(event => event.outcome === 'passed')
  const lines = session.snapshot.lines
  const shortByLine = new Map<string, number>()
  for (const item of shortages) if (item.generation === session.generation && (item.resolved_at === null || item.resolution !== 'cancelled')) shortByLine.set(item.line_id, (shortByLine.get(item.line_id) ?? 0) + item.quantity)
  const status = session.status === 'passed' ? 'Passed' : session.status === 'stale' ? (pass ? 'Passed, then the order changed' : 'Order changed before completion') : 'In progress'
  return <section className="h-full overflow-auto px-4 py-5 md:px-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><Link href="/qc" className="rounded-pill py-2 text-[13px] underline focus-visible:outline-2">← Order QC</Link><Link href={`/qc/${session.order_id.split('/').pop()}`} className="rounded-pill bg-white px-5 py-3 text-[13px] focus-visible:outline-2">Open live checklist</Link></div>
    <div className="mt-4 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-[28px] font-medium tracking-[-0.025em]">{session.snapshot.name}</h1><p className="mt-1 text-[13px] text-ink-soft">Saved QC record · checklist {session.generation} · {status}</p></div>
      <div className={`rounded-pill px-5 py-3 text-[15px] font-medium ${pass ? 'bg-ink text-white' : 'bg-chip'}`}>{pass ? `✓ Passed ${when(pass.created_at)} · ${pass.actor_name}` : 'Not passed'}</div></div>
    <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-ink-soft">This is the record as saved at the time. It does not re-read Shopify. Opening the live checklist re-verifies the order and, if the order has since been fulfilled or edited, will mark the saved pass as needing a recount.</p>
    <div className="mt-5 grid gap-3">{lines.map(line => {
      const count = session.counts[line.id] ?? 0
      const short = shortByLine.get(line.id) ?? 0
      return <article key={line.id} className={`flex flex-wrap items-center gap-4 rounded-panel border bg-white p-3 md:p-4 ${count === line.required ? 'border-green' : short > 0 ? 'border-amber' : 'border-transparent'}`}>
        {line.image
          // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail.
          ? <img src={line.image} alt="" className="h-16 w-16 shrink-0 rounded-panel bg-chip object-cover" />
          : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-panel bg-chip text-[10px] text-ink-soft">No image</div>}
        <div className="min-w-0 flex-1"><h2 className="text-[14px] font-medium">{line.title}</h2><p className="mt-1 text-[13px] text-ink-soft">{line.variantTitle || 'One option'}</p><p className="mt-2 break-all font-mono text-[12px]">{line.barcode || line.sku || 'No saved code'}</p></div>
        <div className="text-right"><p className="text-[20px] font-medium tabular-nums">{count}<span className="text-[14px] text-ink-soft"> / {line.required}</span></p>{short > 0 && <p className="mt-1 text-[12px] text-amber">{short} short</p>}</div>
      </article>
    })}</div>
    {shortages.length > 0 && <div className="mt-4 rounded-card bg-white p-5"><h2 className="text-[15px] font-medium">Shortages on this order</h2><div className="mt-3 grid gap-3">{shortages.map(item => <article key={item.id} className="rounded-panel bg-chip p-4 text-[13px]">
      <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">#{item.ref} · {item.title}{item.variant_title && ` · ${item.variant_title}`} · {item.quantity} short</span><span className="text-ink-soft">{when(item.reported_at)} · {item.reported_by}</span></div>
      <p className="mt-1 text-ink-soft">{item.reason}</p>
      <p className="mt-1">{item.resolved_at ? `Resolved · ${item.resolution} · ${item.resolved_by} · ${when(item.resolved_at)}${item.resolution_note ? ` · ${item.resolution_note}` : ''}` : <span className="text-amber">Open — refund or coupon pending</span>}</p>
    </article>)}</div><Link href="/qc/shortages" className="mt-4 inline-block text-[13px] underline">All shortages</Link></div>}
    <details className="my-5 rounded-card bg-white p-5" open><summary className="cursor-pointer rounded-pill text-[14px] font-medium focus-visible:outline-2">QC history · {events.length} events</summary><ol className="mt-4 grid gap-3">{events.map(event => <li key={event.id} className="border-b border-chip pb-3 text-[12px]"><div className="flex flex-wrap justify-between gap-2"><span>{event.actor_name} · {event.action} · checklist {event.generation}</span><time dateTime={event.created_at} className="text-ink-soft">{when(event.created_at)}</time></div><p className="mt-1 text-ink-soft">{event.message}{event.code && ` · ${event.code}`}</p></li>)}</ol></details>
  </section>
}
