'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { QcCommand, QcView } from '@/lib/qc/types'
import { parseQcCommand } from '@/lib/qc/validation'
import { CameraScan } from './CameraScan'

const button = 'rounded-pill px-5 py-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40'
const time = (value: string) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })

export function QcScreen({ initialView }: { initialView: QcView }) {
  const [view, setView] = useState(initialView)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<QcCommand | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; attention: boolean } | null>(null)
  const [verified, setVerified] = useState(false)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [reason, setReason] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const sequence = useRef(0)
  const endpoint = `/api/qc/${view.order.id.split('/').pop()}`
  const pendingKey = `loupe.qc.pending.${view.operatorId}.${view.order.id}`

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    const seq = ++sequence.current
    try {
      const response = await fetch(endpoint, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not refresh Shopify quantities.')
      if (seq !== sequence.current) return
      setView(payload); setVerified(true); setError(null)
    } catch (cause) {
      if (seq !== sequence.current) return
      setVerified(false); setError(cause instanceof Error ? cause.message : 'Connection interrupted. Refresh before scanning.')
    }
  }, [endpoint])

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(pendingKey)
      // Hydrate a browser-only durable request after SSR; it must never run during server rendering.
      if (saved) {
        const envelope = JSON.parse(saved)
        if (envelope.orderId !== initialView.order.id || envelope.operatorId !== initialView.operatorId) throw new Error('Retry belongs to another order or operator.')
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPending(parseQcCommand(envelope.command)); setNotice({ text: 'A previous request has no confirmed response. Retry it before scanning another unit.', attention: true }) }
    } catch {
      setRecoveryRequired(true); setResetOpen(true)
      setNotice({ text: 'The saved retry could not be read. Review the history and start a fresh checklist before scanning again.', attention: true })
    }
    void refresh()
    input.current?.focus()
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000)
    const catchUp = () => { if (document.visibilityState === 'visible') { setVerified(false); void refresh() } }
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', catchUp); window.removeEventListener('focus', catchUp) }
  }, [pendingKey, refresh, initialView.order.id, initialView.operatorId])

  async function send(command: QcCommand) {
    if (inFlight.current) return
    inFlight.current = true; sequence.current++; setBusy(true); setPending(command); setError(null)
    try {
      // Persist before sending: a lost response or a reload must reuse this UUID.
      sessionStorage.setItem(pendingKey, JSON.stringify({ orderId: view.order.id, operatorId: view.operatorId, command }))
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'QC could not confirm this request. Retry it.')
      setView(payload); setVerified(true)
      sessionStorage.removeItem(pendingKey); setPending(null); setCode(''); setReason(''); setResetOpen(false); setRecoveryRequired(false)
      setNotice({ text: `${payload.replayed ? 'Saved request confirmed. ' : ''}${payload.event?.message ?? 'QC saved.'}`, attention: !['accepted', 'passed', 'undone', 'reset'].includes(payload.event?.outcome) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No confirmed response. Retry this request before scanning another unit.')
    } finally { inFlight.current = false; setBusy(false); input.current?.focus() }
  }

  const stale = view.session.status === 'stale'
  const lines = stale ? view.order.lines : view.session.snapshot.lines
  const required = lines.reduce((sum, line) => sum + line.required, 0)
  const checked = stale ? 0 : lines.reduce((sum, line) => sum + (view.session.counts[line.id] ?? 0), 0)
  const blocked = busy || !!pending || recoveryRequired || !verified || !!view.order.blockedReason || stale
  const undone = new Set(view.events.filter(event => event.undo_of).map(event => event.undo_of))
  const lastOwn = view.events.find(event => event.outcome === 'accepted' && event.actor_id === view.operatorId && event.generation === view.session.generation && !undone.has(event.id))
  const passed = view.session.status === 'passed' && verified && !recoveryRequired && !pending && !view.order.blockedReason

  function submitCode(scannedCode: string) {
    if (blocked || !scannedCode.trim()) return
    try { void send(parseQcCommand({ action: 'scan', requestId: crypto.randomUUID(), code: scannedCode, expectedGeneration: view.session.generation })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Scan a valid code.'); input.current?.select() }
  }

  function scan(event: FormEvent) { event.preventDefault(); submitCode(code) }

  return <section className="h-full overflow-auto px-4 py-5 md:px-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><Link href="/qc" className="rounded-pill py-2 text-[13px] underline focus-visible:outline-2">← Order QC</Link><Link href="/labels" className={`${button} bg-white`}>Prepare labels</Link></div>
    <div className="mt-4 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-[28px] font-medium tracking-[-0.025em]">{view.order.name}</h1><p className="mt-1 text-[13px] text-ink-soft">All remaining shipping units · checklist {view.session.generation}</p></div><div className="rounded-pill bg-ink px-5 py-3 text-[15px] font-medium text-white">{checked} / {required} checked</div></div>
    <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-ink-soft">Scan one pouch, wait for acceptance, then move it into this order’s box. A pair or set sold as one unit needs one scan. Check the whole remaining order together, including items at other locations. Repeated scans of the same physical pouch cannot be distinguished.</p>
    {(view.order.blockedReason || stale) && <div role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">{view.order.blockedReason || 'Shopify changed this order’s items, quantities or codes. Previous counts are preserved in history. Start a fresh checklist and recount every unit.'}</div>}
    <div className="sticky top-0 z-10 mt-5 rounded-card bg-white p-4 shadow-sm md:p-5">
      <form onSubmit={scan} className="flex flex-wrap items-end gap-3"><label className="grid min-w-0 flex-1 gap-2 text-[12px]" htmlFor="qc-code">Scan barcode or SKU<input ref={input} id="qc-code" value={code} onChange={event => setCode(event.target.value)} readOnly={blocked} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="Click here, scan, then Enter" className="min-w-0 rounded-pill bg-chip px-4 py-3 font-mono text-[16px] focus:outline-2 focus:outline-ink" /></label><button disabled={blocked || !code.trim()} className={`${button} bg-ink text-white`}>{busy ? 'Checking…' : 'Check 1 unit ↵'}</button></form>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-soft"><span>{verified ? `Shopify verified at ${time(view.session.checked_at)}` : 'Shopify verification needed'} · {busy ? 'Wait for the result before the next scan' : '2D USB/Bluetooth scanner with Enter'}</span><button disabled={busy || !!pending} onClick={() => void refresh()} className="rounded-pill px-3 py-1 underline focus-visible:outline-2 disabled:opacity-40">Refresh order</button></div>
      {!blocked && <CameraScan key={view.session.generation} onCode={submitCode} />}
      {notice && <p role={notice.attention ? 'alert' : 'status'} aria-live="polite" className={`mt-3 text-[13px] ${notice.attention ? 'text-amber' : 'text-ink'}`}>{notice.text}</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-amber">{error}</p>}
      {pending && !busy && <button onClick={() => void send(pending)} className={`${button} mt-3 bg-ink text-white`}>Retry the same request safely</button>}
      {passed && <div role="status" className="mt-4 rounded-panel bg-chip p-4 text-[13px]"><strong>✓ QC passed</strong><p className="mt-1">Every remaining shipping unit was checked at {time(view.session.completed_at!)}. Fulfill the order in Shopify after packing. Order changes will require a new check.</p></div>}
    </div>
    <div className="mt-4 grid gap-3">{lines.map(line => {
      const count = stale ? 0 : view.session.counts[line.id] ?? 0
      const done = count === line.required
      return <article key={line.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-panel border bg-white p-4 ${done ? 'border-ink' : 'border-transparent'}`}>
        <div className="min-w-0"><h2 className={`text-[14px] font-medium ${done ? 'line-through' : ''}`}>{done && '✓ '}{line.title}</h2><p className="mt-1 text-[13px] text-ink-soft">{line.variantTitle || 'One option'}</p><p className="mt-2 break-all font-mono text-[12px]">{line.barcode || line.sku || 'No saved code'}</p>{!line.barcode && <Link href={line.sku ? `/labels?q=${encodeURIComponent(line.sku)}` : '/labels'} className="mt-1 inline-block text-[12px] text-amber underline">Barcode missing · prepare labels</Link>}</div>
        <div className="text-right"><p className="text-[20px] font-medium tabular-nums">{count}<span className="text-[14px] text-ink-soft"> / {line.required}</span></p><p className="mt-1 text-[12px] text-ink-soft">{done ? 'Checked' : `${line.required - count} to scan`}</p></div>
      </article>
    })}</div>
    <div className="mt-5 flex flex-wrap gap-3"><button disabled={blocked || checked !== required || required === 0 || passed} onClick={() => void send({ action: 'complete', requestId: crypto.randomUUID(), expectedVersion: view.session.version })} className={`${button} bg-ink text-white`}>Complete QC</button><button disabled={busy || !!pending} onClick={() => { setResetOpen(!resetOpen); setReason('') }} className={`${button} bg-white`}>Recount / undo</button></div>
    {resetOpen && <div className="mt-4 rounded-card bg-white p-5"><h2 className="text-[15px] font-medium">Correct the checklist</h2><p className="mt-2 text-[12px] text-ink-soft">Undo removes one of your counted units. Starting fresh clears the current counts and keeps the previous checklist in the audit history.</p><label className="mt-4 grid gap-2 text-[12px]">Reason<input value={reason} onChange={event => setReason(event.target.value)} maxLength={240} placeholder="For example: repacking into a new box" className="rounded-pill bg-chip px-4 py-3 focus:outline-2 focus:outline-ink" /></label><div className="mt-4 flex flex-wrap gap-3"><button disabled={blocked || !lastOwn || reason.trim().length < 3} onClick={() => lastOwn && void send({ action: 'undo', requestId: crypto.randomUUID(), undoEventId: lastOwn.id, expectedVersion: view.session.version, reason })} className={`${button} bg-chip`}>Undo my last counted unit</button><button disabled={busy || !!pending || !verified || !!view.order.blockedReason || reason.trim().length < 3} onClick={() => void send({ action: 'reset', requestId: crypto.randomUUID(), expectedVersion: view.session.version, reason })} className={`${button} bg-ink text-white`}>Start fresh · recount all {required} units</button></div></div>}
    <details className="my-5 rounded-card bg-white p-5"><summary className="cursor-pointer rounded-pill text-[14px] font-medium focus-visible:outline-2">Recent QC history · {view.events.length} events</summary><ol className="mt-4 grid gap-3">{view.events.map(event => <li key={event.id} className="border-b border-chip pb-3 text-[12px]"><div className="flex flex-wrap justify-between gap-2"><span>{event.actor_name} · {event.action} · checklist {event.generation}</span><time dateTime={event.created_at} className="text-ink-soft">{new Date(event.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} {time(event.created_at)}</time></div><p className="mt-1 text-ink-soft">{event.message}{event.code && ` · ${event.code}`}</p></li>)}</ol><p className="mt-3 text-[12px] text-ink-soft">Showing the most recent 40 events. Earlier checklists remain saved.</p></details>
  </section>
}
