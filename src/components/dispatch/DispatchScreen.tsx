'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { discardParcelAction, groupOrderAction, pushParcelAction, stageTrackingAction, ungroupOrderAction } from '@/app/(shell)/dispatch/actions'
import { detectCarrier, normalizeTracking } from '@/lib/dispatch/carrier'
import { buildRows, canPush, duplicateTracking, isStaged, parcelFrozen, rowLocked, type DispatchRowModel } from '@/lib/dispatch/rows'
import { runPush, type PushTarget } from '@/lib/dispatch/push-loop'
import { CARRIERS, type DispatchOrderSummary, type ParcelRow } from '@/lib/dispatch/types'
import type { PushResult } from '@/lib/dispatch/push'

export interface DispatchScreenProps { orders: DispatchOrderSummary[]; qcPassed: Record<string, boolean>; open: ParcelRow[]; recent: ParcelRow[]; truncated: boolean; ordersLoaded: boolean; error?: string }

const when = (value: string) => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const field = 'min-w-0 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink disabled:opacity-40'
const pill = 'rounded-pill px-4 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40'

function QcBadge({ passed }: { passed: boolean }) {
  const label = passed ? 'QC checked' : 'QC not checked'
  return <span role="img" aria-label={label} title={label} className={`inline-grid h-5 w-5 shrink-0 place-items-center rounded-full ${passed ? 'bg-ink text-white' : 'border border-chip text-ink-soft'}`}>
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{passed ? <path d="M3 8.5l3 3 7-7" /> : <path d="M4 8h8" />}</svg>
  </span>
}

export function DispatchScreen({ orders, qcPassed, open, recent, truncated, ordersLoaded, error }: DispatchScreenProps) {
  const router = useRouter()
  const rows = useMemo(() => buildRows(orders, qcPassed, open), [orders, qcPassed, open])
  const duplicates = useMemo(() => duplicateTracking(rows), [rows])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [results, setResults] = useState<PushResult[]>([])
  const [pushing, setPushing] = useState(false)
  // In-flight save count. Read synchronously by event handlers (so a click cannot race a stale render);
  // mirrored into state only so the Push label can show "Saving…". Never feeds `rowLocked` — the round-1
  // scanner-focus fix depends on a save never disabling a field.
  const savingRef = useRef(0)
  const [saving, setSaving] = useState(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const staged = rows.filter(isStaged)
  const chosen = staged.filter(row => selected.has(row.order.id))
  const chosenOrders = chosen.reduce((sum, row) => sum + 1 + row.children.length, 0)
  const note = (id: string, message: string) => setMessages(current => ({ ...current, [id]: message }))
  /** A rejected action (dropped connection, session redirect) must still tell the row something went wrong. */
  const act = (id: string, work: () => Promise<{ ok: boolean; message: string }>, after?: () => void) => {
    savingRef.current += 1
    setSaving(savingRef.current)
    work()
      .then(state => { note(id, state.ok ? '' : state.message); if (state.ok) { after?.(); router.refresh() } })
      .catch(() => note(id, 'Loupe could not be reached, so nothing was saved. Try again.'))
      .finally(() => { savingRef.current -= 1; setSaving(savingRef.current) })
  }
  const save = (row: DispatchRowModel, tracking: string, carrier?: string) => act(row.order.id,
    () => stageTrackingAction({ orderId: row.order.id, orderName: row.order.name, tracking, carrier }),
    () => setDrafts(current => { const next = { ...current }; delete next[row.order.id]; return next }))
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (confirming) { if (!dialog.open) dialog.showModal(); cancelRef.current?.focus() }
    else if (dialog.open) dialog.close()
  }, [confirming])

  /** Guards against a click racing a stale render: reads the ref directly, not the mirrored `saving` state. */
  const openConfirm = () => { if (savingRef.current > 0) return; setConfirming(true) }

  const push = () => {
    if (savingRef.current > 0) return
    setConfirming(false)
    setPushing(true)
    setResults([])
    const targets: PushTarget[] = chosen.map(row => ({ parcelId: row.parcel!.id, orderId: row.order.id, orderName: row.order.name }))
    void (async () => {
      try { await runPush(targets, pushParcelAction, setResults) }
      finally { setPushing(false); setSelected(new Set()); router.refresh() }
    })()
  }

  return <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
    <h1 className="text-[26px] font-medium tracking-[-0.025em]">Dispatch</h1>
    <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Orders marked In progress in Shopify. Type or scan a tracking number to stage it, select the staged rows, then push: each order is fulfilled with its carrier and number, and the customer is notified.</p>
    {error && <p role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">{error}</p>}
    {truncated && <p role="status" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">There are more than 300 open orders, so this list may be incomplete. Archive old fulfilled orders in Shopify.</p>}

    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">In progress · {rows.length}</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${pill} bg-chip`} disabled={staged.length === 0} onClick={() => setSelected(new Set(staged.map(row => row.order.id)))}>Select all staged ({staged.length})</button>
          <button type="button" className={`${pill} bg-ink text-white`} disabled={!canPush(chosen.length, pushing, saving)} onClick={openConfirm}>{saving > 0 ? 'Saving…' : `Push ${chosen.length} parcel${chosen.length === 1 ? '' : 's'} · ${chosenOrders} order${chosenOrders === 1 ? '' : 's'}`}</button>
        </div>
      </div>
      {rows.length === 0 && !error && <p className="py-8 text-[13px] text-ink-soft">Nothing is marked In progress in Shopify.</p>}
      <div className="grid gap-3">{rows.map((row, index) => {
        const id = row.order.id
        const locked = rowLocked(row.status, pushing)
        // Part of this parcel is already with a customer: its number can only be discarded, never re-typed.
        const frozen = parcelFrozen(row.parcel)
        const tracking = drafts[id] ?? row.parcel?.tracking_number ?? ''
        const carrier = row.parcel?.carrier ?? detectCarrier(normalizeTracking(tracking)) ?? ''
        const sharing = row.parcel?.tracking_number && duplicates.has(row.parcel.tracking_number) ? rows.filter(other => other.order.id !== id && other.parcel?.tracking_number === row.parcel!.tracking_number) : []
        const candidates = adding === id ? rows.filter(other => other.order.id !== id && other.listed && other.children.length === 0 && other.status !== 'pushing' && other.order.name.toLowerCase().includes(search.trim().toLowerCase()))
          .sort((a, b) => Number(b.order.addressKey === row.order.addressKey) - Number(a.order.addressKey === row.order.addressKey)).slice(0, 8) : []
        return <div key={id} className="rounded-panel border border-chip bg-white p-3 md:p-4">
          <div className="grid items-center gap-3 md:grid-cols-[auto_auto_minmax(0,1.2fr)_minmax(0,1fr)_170px_minmax(0,1.4fr)_auto]">
            <input type="checkbox" aria-label={`Select ${row.order.name}`} checked={selected.has(id)} disabled={!isStaged(row) || locked} onChange={() => toggle(id)} className="h-4 w-4" />
            <QcBadge passed={row.qcPassed} />
            <div className="flex items-center gap-2"><span className="text-[15px] font-medium">{row.order.name}</span>
              <button type="button" aria-label={`Add another order to the parcel of ${row.order.name}`} title="Add an order that travels in the same parcel" disabled={locked || frozen} onClick={() => { setAdding(adding === id ? null : id); setSearch('') }} className="inline-grid h-6 w-6 place-items-center rounded-full bg-chip text-[15px] leading-none focus-visible:outline-2">+</button></div>
            <span className="truncate text-[12px] text-ink-soft">{row.order.customer}</span>
            <select aria-label={`Carrier for ${row.order.name}`} value={carrier} disabled={locked || frozen} onChange={event => save(row, tracking, event.target.value)} className={field}>
              <option value="">{row.parcel?.carrier_source === 'manual' ? 'Detect automatically' : '— carrier —'}</option>
              {CARRIERS.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <input aria-label={`Tracking number for ${row.order.name}`} data-tracking-index={index} value={tracking} disabled={locked || frozen} maxLength={40} placeholder="Tracking number" autoComplete="off" spellCheck={false} className={field}
              onChange={event => setDrafts(current => ({ ...current, [id]: event.target.value }))}
              onBlur={() => { if (id in drafts && normalizeTracking(drafts[id]) !== (row.parcel?.tracking_number ?? '')) save(row, drafts[id]) }}
              onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); event.currentTarget.blur(); document.querySelector<HTMLInputElement>(`[data-tracking-index="${index + 1}"]`)?.focus() }} />
            <span className="rounded-pill bg-chip px-3 py-2 text-[12px]">{row.status === 'pushing' ? 'pushing…' : row.status === 'failed' ? 'failed' : isStaged(row) ? 'staged' : '—'}</span>
          </div>
          {row.children.map(child => <div key={child.orderId} className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-chip pl-3 text-[13px] md:ml-12">
            <QcBadge passed={child.qcPassed} /><span className="font-medium">{child.orderName}</span><span className="text-[12px] text-ink-soft">same parcel</span>
            {child.differentAddress && <span className="text-[12px] text-amber">different delivery address</span>}
            {ordersLoaded && !child.listed && <span className="text-[12px] text-amber">no longer In progress</span>}
            {child.error && <span className="text-[12px] text-amber">{child.error}</span>}
            <button type="button" aria-label={`Remove ${child.orderName} from this parcel`} disabled={locked || child.status === 'pushing'} onClick={() => act(id, () => ungroupOrderAction(child.orderId))} className="inline-grid h-6 w-6 place-items-center rounded-full bg-chip leading-none focus-visible:outline-2">×</button>
          </div>)}
          {adding === id && <div className="mt-3 rounded-panel bg-chip p-3 md:ml-12">
            <input aria-label="Find an order to add" value={search} onChange={event => setSearch(event.target.value)} placeholder="Order number, for example Qimati5899" className={`${field} w-full bg-white`} />
            <div className="mt-2 flex flex-wrap gap-2">{candidates.map(other => <button key={other.order.id} type="button" className={`${pill} bg-white`} onClick={() => act(id, () => groupOrderAction({ primaryOrderId: id, primaryOrderName: row.order.name, orderId: other.order.id, orderName: other.order.name }), () => setAdding(null))}>{other.order.name}{other.order.addressKey && other.order.addressKey === row.order.addressKey ? ' · same address' : ''}</button>)}
              {candidates.length === 0 && <span className="text-[12px] text-ink-soft">No other In-progress order matches. Mark it In progress in Shopify first.</span>}</div>
          </div>}
          {frozen
            ? <p className="mt-2 text-[12px] text-amber">Part of this parcel was already pushed with {row.parcel!.carrier} {row.parcel!.tracking_number}, so its number can no longer change. Push {row.order.name} again with that number, or <button type="button" className="underline" disabled={locked} onClick={() => act(id, () => discardParcelAction(row.parcel!.id))}>Discard the remaining order</button>.</p>
            : ordersLoaded && !row.listed && <p className="mt-2 text-[12px] text-amber">{row.order.name} is no longer In progress in Shopify. <button type="button" className="underline" disabled={locked} onClick={() => act(id, () => discardParcelAction(row.parcel!.id))}>Discard this staged number</button></p>}
          {sharing.map(other => <p key={other.order.id} className="mt-2 text-[12px] text-amber">Same number as {other.order.name}. <button type="button" className="underline" disabled={locked} onClick={() => act(id, () => groupOrderAction({ primaryOrderId: id, primaryOrderName: row.order.name, orderId: other.order.id, orderName: other.order.name }))}>Group them into one parcel</button></p>)}
          {row.error && <p className="mt-2 text-[12px] text-amber">{row.error}</p>}
          {messages[id] && <p role="alert" className="mt-2 text-[12px] text-amber">{messages[id]}</p>}
        </div>
      })}</div>
      {results.length > 0 && <div role="status" className="mt-5 rounded-panel bg-white p-4 text-[13px]"><h3 className="mb-2 font-medium">Last push</h3>
        {results.map(result => <p key={result.orderId} className={result.status === 'fulfilled' ? '' : 'text-amber'}>{result.status === 'fulfilled' ? '✓' : '!'} {result.orderName} — {result.message}</p>)}</div>}
    </div>

    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <h2 className="mb-4 text-[15px] font-medium">Pushed in the last 30 days · {recent.length}</h2>
      {recent.length === 0 && <p className="py-4 text-[13px] text-ink-soft">Nothing has been pushed yet.</p>}
      <div className="grid gap-2">{recent.map(parcel => <div key={parcel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-chip bg-white p-3 text-[13px]">
        <span className="font-medium">{parcel.orders.filter(item => item.status === 'fulfilled').map(item => item.order_name).join(' + ')}</span>
        <span>{parcel.carrier} {parcel.tracking_number}</span>
        <span className="text-[12px] text-ink-soft">{parcel.pushed_at ? when(parcel.pushed_at) : ''} · {parcel.pushed_by}</span>
      </div>)}</div>
    </div>

    <dialog ref={dialogRef} aria-label="Confirm push" onClose={() => setConfirming(false)}
      onClick={event => { if (event.target === dialogRef.current) dialogRef.current?.close() }}
      className="m-auto max-h-[80vh] w-full max-w-lg overflow-auto rounded-card bg-white p-5 backdrop:bg-black/40">
      <h2 className="text-[17px] font-medium">Fulfil {chosenOrders} order{chosenOrders === 1 ? '' : 's'}?</h2>
      <p className="mt-2 text-[13px] text-ink-soft">Shopify emails each customer and the WhatsApp bot sends the shipped message. This cannot be recalled.</p>
      <div className="mt-4 grid gap-2 text-[13px]">{chosen.map(row => <p key={row.order.id}><span className="font-medium">{[row.order.name, ...row.children.map(child => child.orderName)].join(' + ')}</span> → {row.parcel!.carrier} {row.parcel!.tracking_number}</p>)}</div>
      <div className="mt-5 flex justify-end gap-2"><button ref={cancelRef} type="button" className={`${pill} bg-chip`} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className={`${pill} bg-ink text-white`} onClick={push}>Fulfil and notify customers</button></div>
    </dialog>
  </section>
}
