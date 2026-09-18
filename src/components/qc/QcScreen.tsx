'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { QcCommand, QcView } from '@/lib/qc/types'
import { parseQcCommand } from '@/lib/qc/validation'
import { summarizeQc } from '@/lib/qc/summary'
import { playQcTone, toneForOutcome, vibrateQc, type QcTone } from '@/lib/qc/sound'
import { CameraScan } from './CameraScan'

const button = 'rounded-pill px-5 py-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40'
const time = (value: string) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })

interface Feedback { tone: QcTone; headline: string; message: string; image: string | null; title: string | null; variantTitle: string | null; progress: string | null; code: string | null }

/** A small inline "reason, then confirm" control; every count-changing correction needs an audit reason. */
function ReasonAction({ label, confirm, disabled, onConfirm }: { label: string; confirm: string; disabled: boolean; onConfirm: (reason: string) => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={`${button} bg-white border border-chip`}>{label}</button>
  return <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (reason.trim().length >= 3) { onConfirm(reason.trim()); setOpen(false); setReason('') } }}>
    <input autoFocus value={reason} onChange={event => setReason(event.target.value)} maxLength={240} placeholder="Reason (for example: not in stock)" className="min-w-0 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink" />
    <button disabled={disabled || reason.trim().length < 3} className={`${button} bg-ink text-white`}>{confirm}</button>
    <button type="button" onClick={() => { setOpen(false); setReason('') }} className={`${button} bg-white`}>Cancel</button>
  </form>
}

export function QcScreen({ initialView }: { initialView: QcView }) {
  const [view, setView] = useState(initialView)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<QcCommand | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; attention: boolean } | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [verified, setVerified] = useState(false)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [reason, setReason] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cameraOpen = useRef(false)
  const cameraOpenChanged = useCallback((open: boolean) => { cameraOpen.current = open }, [])
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
    // A 2D scanner gun types into whatever is focused: pull stray keystrokes back into the code field.
    const capture = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (!editable && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !cameraOpen.current) input.current?.focus()
    }
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
    window.addEventListener('keydown', capture)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', catchUp); window.removeEventListener('focus', catchUp); window.removeEventListener('keydown', capture) }
  }, [pendingKey, refresh, initialView.order.id, initialView.operatorId])

  function signal(tone: QcTone) { void playQcTone(tone); vibrateQc(tone) }

  async function send(command: QcCommand) {
    if (inFlight.current) return
    inFlight.current = true; sequence.current++; setBusy(true); setPending(command); setError(null)
    try {
      // Persist before sending: a lost response or a reload must reuse this UUID.
      sessionStorage.setItem(pendingKey, JSON.stringify({ orderId: view.order.id, operatorId: view.operatorId, command }))
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })
      const payload: QcView = await response.json()
      if (!response.ok) throw new Error((payload as unknown as { error?: string }).error || 'QC could not confirm this request. Retry it.')
      setView(payload); setVerified(true)
      sessionStorage.removeItem(pendingKey); setPending(null); setCode(''); setReason(''); setResetOpen(false); setRecoveryRequired(false)
      const outcome = payload.event?.outcome
      setNotice({ text: `${payload.replayed ? 'Saved request confirmed. ' : ''}${payload.event?.message ?? 'QC saved.'}`, attention: !['accepted', 'passed', 'undone', 'reset', 'removed', 'short'].includes(outcome ?? '') })
      const tone = toneForOutcome(outcome)
      if (tone && command.action !== 'reset') {
        signal(tone)
        const line = payload.session.snapshot.lines.find(item => item.id === payload.event?.line_id) ?? payload.session.snapshot.lines.find(item => payload.event?.variant_id != null && item.variantId === payload.event?.variant_id)
        const fresh = line && payload.order.lines.find(item => item.id === line.id)
        const count = line ? payload.session.counts[line.id] ?? 0 : null
        setFeedback({
          tone,
          headline: outcome === 'accepted' ? '✓ Checked' : outcome === 'passed' ? '✓ QC passed' : outcome === 'short' ? 'Marked short' : outcome === 'removed' ? '✓ Extra removed' : outcome === 'extra' ? 'Extra unit' : outcome === 'wrong' ? 'Not on this order' : outcome === 'rejected' ? 'Not accepted' : 'Check the message',
          message: payload.event?.message ?? '',
          image: fresh?.image ?? line?.image ?? null, title: line?.title ?? null, variantTitle: line?.variantTitle ?? null,
          progress: line && count !== null ? `${count} / ${line.required}` : null,
          code: payload.event?.code ?? null,
        })
      }
    } catch (cause) {
      signal('reject')
      setError(cause instanceof Error ? cause.message : 'No confirmed response. Retry this request before scanning another unit.')
    } finally { inFlight.current = false; setBusy(false); if (!cameraOpen.current) input.current?.focus() }
  }

  const stale = view.session.status === 'stale'
  const lines = stale ? view.order.lines : view.session.snapshot.lines
  const images = new Map(view.order.lines.map(line => [line.id, line.image ?? null]))
  const required = lines.reduce((sum, line) => sum + line.required, 0)
  const checked = stale ? 0 : lines.reduce((sum, line) => sum + (view.session.counts[line.id] ?? 0), 0)
  const blocked = busy || !!pending || recoveryRequired || !verified || !!view.order.blockedReason || stale
  const undone = new Set(view.events.filter(event => event.undo_of).map(event => event.undo_of))
  const lastOwn = view.events.find(event => event.outcome === 'accepted' && event.actor_id === view.operatorId && event.generation === view.session.generation && !undone.has(event.id))
  const passed = view.session.status === 'passed' && verified && !recoveryRequired && !pending && !view.order.blockedReason
  const wrap = summarizeQc(view.session, view.events, view.shortages)
  const shortTotal = stale ? 0 : view.shortages.reduce((sum, item) => sum + item.quantity, 0)
  const actionsBlocked = busy || !!pending || recoveryRequired || !verified || stale

  function submitCode(scannedCode: string) {
    if (blocked || !scannedCode.trim()) return
    try { void send(parseQcCommand({ action: 'scan', requestId: crypto.randomUUID(), code: scannedCode, expectedGeneration: view.session.generation })) }
    catch (cause) { signal('reject'); setError(cause instanceof Error ? cause.message : 'Scan a valid code.'); if (!cameraOpen.current) input.current?.select() }
  }

  function scan(event: FormEvent) { event.preventDefault(); submitCode(code) }

  const feedbackClass = feedback?.tone === 'accept' ? 'border-green bg-white' : feedback?.tone === 'passed' ? 'border-green bg-chip' : 'border-amber bg-white'
  const feedbackText = feedback?.tone === 'reject' ? 'text-amber' : 'text-green'

  return <section className="h-full overflow-auto px-4 py-5 md:px-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><Link href="/qc" className="rounded-pill py-2 text-[13px] underline focus-visible:outline-2">← Order QC</Link><div className="flex gap-2"><Link href="/qc/shortages" className={`${button} bg-white`}>Shortages</Link><Link href="/labels" className={`${button} bg-white`}>Prepare labels</Link></div></div>
    <div className="mt-4 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-[28px] font-medium tracking-[-0.025em]">{view.order.name}</h1><p className="mt-1 text-[13px] text-ink-soft">All remaining shipping units · checklist {view.session.generation}</p></div><div className="rounded-pill bg-ink px-5 py-3 text-[15px] font-medium text-white">{checked} / {required} checked{shortTotal > 0 && <span className="text-amber"> · {shortTotal} short</span>}</div></div>
    <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-ink-soft">Scan each pouch with the 2D scanner, listen for the tone, then move it into this order’s box. A pair or set sold as one unit needs one scan. Repeated scans of the same physical pouch cannot be distinguished.</p>
    {(view.order.blockedReason || stale) && <div role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">{view.order.blockedReason || 'Shopify changed this order’s items, quantities or codes. Previous counts are preserved in history. Start a fresh checklist and recount every unit.'}</div>}
    <div className="sticky top-0 z-10 mt-5 rounded-card bg-white p-4 shadow-sm md:p-5">
      <form onSubmit={scan} className="flex flex-wrap items-end gap-3"><label className="grid min-w-0 flex-1 gap-2 text-[12px]" htmlFor="qc-code">Scan barcode or SKU<input ref={input} id="qc-code" value={code} onChange={event => setCode(event.target.value)} readOnly={blocked} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="Scanner ready — scan a pouch" className="min-w-0 rounded-pill bg-chip px-4 py-3 font-mono text-[16px] focus:outline-2 focus:outline-ink" /></label><button disabled={blocked || !code.trim()} className={`${button} bg-ink text-white`}>{busy ? 'Checking…' : 'Check 1 unit ↵'}</button></form>
      {feedback && <div role="status" aria-live="assertive" className={`mt-3 flex items-center gap-4 rounded-panel border-2 p-3 ${feedbackClass}`}>
        {feedback.image
          // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail of the scanned line.
          ? <img src={feedback.image} alt="" className="h-24 w-24 shrink-0 rounded-panel bg-chip object-cover md:h-32 md:w-32" />
          : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-panel bg-chip text-[11px] text-ink-soft md:h-32 md:w-32">No image</div>}
        <div className="min-w-0 flex-1">
          <p className={`text-[20px] font-medium ${feedbackText}`}>{feedback.headline}{feedback.progress && <span className="ml-3 text-[16px] text-ink">{feedback.progress}</span>}</p>
          {feedback.title && <p className="mt-1 truncate text-[15px] font-medium">{feedback.title}<span className="text-ink-soft"> · {feedback.variantTitle || 'One option'}</span></p>}
          <p className="mt-1 text-[12px] text-ink-soft">{feedback.message}{feedback.code && !feedback.title && <span className="font-mono"> · {feedback.code}</span>}</p>
        </div>
      </div>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-soft"><span>{verified ? `Shopify verified at ${time(view.session.checked_at)}` : 'Shopify verification needed'} · {busy ? 'Wait for the tone before the next scan' : 'Scanner sends Enter after each code'}</span><button disabled={busy || !!pending} onClick={() => void refresh()} className="rounded-pill px-3 py-1 underline focus-visible:outline-2 disabled:opacity-40">Refresh order</button></div>
      {notice && <p role={notice.attention ? 'alert' : 'status'} aria-live="polite" className={`mt-3 text-[13px] ${notice.attention ? 'text-amber' : 'text-ink'}`}>{notice.text}</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-amber">{error}</p>}
      {pending && !busy && <button onClick={() => void send(pending)} className={`${button} mt-3 bg-ink text-white`}>Retry the same request safely</button>}
      <CameraScan paused={blocked || resetOpen} onCode={submitCode} onOpenChange={cameraOpenChanged} />
      {passed && <div role="status" className="mt-4 rounded-panel bg-chip p-4 text-[13px]"><strong>✓ QC passed</strong><p className="mt-1">Every remaining shipping unit was checked at {time(view.session.completed_at!)}{shortTotal > 0 ? `, with ${shortTotal} unit(s) accepted as short and listed under Shortages for refund or coupon` : ''}. Extra items were confirmed removed. Fulfill the order in Shopify after packing. Order changes will require a new check.</p></div>}
    </div>
    <div className="mt-4 grid gap-3">{lines.map(line => {
      const count = stale ? 0 : view.session.counts[line.id] ?? 0
      const short = stale ? 0 : wrap.shortByLine[line.id] ?? 0
      const done = count === line.required
      const settled = count + short === line.required
      const image = images.get(line.id) ?? line.image ?? null
      return <article key={line.id} className={`flex flex-wrap items-center gap-4 rounded-panel border bg-white p-3 md:p-4 ${done ? 'border-green' : settled ? 'border-amber' : 'border-transparent'}`}>
        {image
          // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail.
          ? <img src={image} alt="" className={`h-16 w-16 shrink-0 rounded-panel bg-chip object-cover ${done ? 'opacity-50' : ''}`} />
          : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-panel bg-chip text-[10px] text-ink-soft">No image</div>}
        <div className="min-w-0 flex-1"><h2 className={`text-[14px] font-medium ${done ? 'line-through' : ''}`}>{done && '✓ '}{line.title}</h2><p className="mt-1 text-[13px] text-ink-soft">{line.variantTitle || 'One option'}</p><p className="mt-2 break-all font-mono text-[12px]">{line.barcode || line.sku || 'No saved code'}</p>{!line.barcode && <Link href={line.sku ? `/labels?q=${encodeURIComponent(line.sku)}` : '/labels'} className="mt-1 inline-block text-[12px] text-amber underline">Barcode missing · prepare labels</Link>}</div>
        <div className="text-right"><p className="text-[20px] font-medium tabular-nums">{count}<span className="text-[14px] text-ink-soft"> / {line.required}</span></p><p className="mt-1 text-[12px] text-ink-soft">{done ? 'Checked' : short > 0 && settled ? `${short} short · accepted` : `${line.required - count - short} to scan${short > 0 ? ` · ${short} short` : ''}`}</p></div>
      </article>
    })}</div>
    {(wrap.missing.length > 0 || wrap.extras.length > 0 || view.shortages.length > 0) && !stale && <div className="mt-4 rounded-card bg-white p-5">
      <h2 className="text-[15px] font-medium">End of QC</h2>
      <p className="mt-2 text-[12px] text-ink-soft">Missing items still need a scan. If you do not have a unit at all, mark it short: QC can then pass without it, and it goes on the Shortages list until the customer is refunded or sent a coupon. Extra items stay listed until you tick that you took them out of this order’s box.</p>
      {wrap.missing.length > 0 && <div className="mt-4 grid gap-3">{wrap.missing.map(item => <article key={item.lineId} className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-chip p-4">
        <div className="min-w-0"><h3 className="text-[14px] font-medium">{item.title}</h3><p className="mt-1 text-[13px] text-ink-soft">{item.variantTitle || 'One option'} · missing</p></div>
        <div className="flex flex-wrap items-center gap-3"><p className="text-[20px] font-medium tabular-nums text-amber">{item.remaining}<span className="text-[14px] text-ink-soft"> short</span></p>
          <ReasonAction label={`Don’t have it · mark ${item.remaining} short`} confirm="Mark short" disabled={actionsBlocked || !!view.order.blockedReason} onConfirm={reasonText => void send({ action: 'short', requestId: crypto.randomUUID(), lineId: item.lineId, expectedVersion: view.session.version, reason: reasonText })} /></div>
      </article>)}</div>}
      {view.shortages.length > 0 && <div className="mt-4 grid gap-3"><p className="text-[12px] uppercase tracking-[0.11em] text-ink-soft">Accepted as short</p>{view.shortages.map(item => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-amber bg-white p-4">
        <div className="min-w-0"><h3 className="text-[14px] font-medium">#{item.ref} · {item.title}</h3><p className="mt-1 text-[13px] text-ink-soft">{item.variant_title || 'One option'} · {item.quantity} short · {item.reason}</p><p className="mt-1 text-[12px] text-ink-soft">Scanning this unit now closes the shortage automatically.</p></div>
        <ReasonAction label="Undo shortage" confirm="Undo" disabled={actionsBlocked || !!view.order.blockedReason} onConfirm={reasonText => void send({ action: 'undo', requestId: crypto.randomUUID(), undoEventId: item.event_id, expectedVersion: view.session.version, reason: reasonText })} />
      </article>)}</div>}
      {wrap.extras.length > 0 && <div className="mt-4 grid gap-3"><p className="text-[12px] uppercase tracking-[0.11em] text-ink-soft">Extra items</p>{wrap.extras.map(item => <article key={item.eventId} className={`flex flex-wrap items-center justify-between gap-3 rounded-panel border bg-white p-4 ${item.removed ? 'border-ink' : 'border-amber'}`}>
        <div className="min-w-0"><h3 className={`text-[14px] font-medium ${item.removed ? 'line-through' : ''}`}>{item.removed && '✓ '}{item.title}</h3><p className="mt-1 text-[13px] text-ink-soft">{item.kind === 'wrong' ? 'Not on this order' : 'Extra unit of a listed variant'}</p>{item.code && <p className="mt-2 break-all font-mono text-[12px]">{item.code}</p>}</div>
        {item.removed ? <p className="text-[13px] font-medium">✓ Removed</p> : <button disabled={actionsBlocked} onClick={() => void send({ action: 'clear_extra', requestId: crypto.randomUUID(), extraEventId: item.eventId, expectedVersion: view.session.version })} className={`${button} bg-ink text-white`}>Tick — removed</button>}
      </article>)}</div>}
    </div>}
    <div className="mt-5 flex flex-wrap gap-3"><button disabled={blocked || !wrap.canPass || passed} onClick={() => void send({ action: 'complete', requestId: crypto.randomUUID(), expectedVersion: view.session.version })} className={`${button} bg-ink text-white`}>{shortTotal > 0 ? `Complete QC · ${shortTotal} short` : 'Complete QC'}</button><button disabled={busy || !!pending} onClick={() => { setResetOpen(!resetOpen); setReason('') }} className={`${button} bg-white`}>Recount / undo</button></div>
    {resetOpen && <div className="mt-4 rounded-card bg-white p-5"><h2 className="text-[15px] font-medium">Correct the checklist</h2><p className="mt-2 text-[12px] text-ink-soft">Undo removes one of your counted units. Starting fresh clears the current counts and accepted shortages, and keeps the previous checklist in the audit history.</p><label className="mt-4 grid gap-2 text-[12px]">Reason<input value={reason} onChange={event => setReason(event.target.value)} maxLength={240} placeholder="For example: repacking into a new box" className="rounded-pill bg-chip px-4 py-3 focus:outline-2 focus:outline-ink" /></label><div className="mt-4 flex flex-wrap gap-3"><button disabled={blocked || !lastOwn || reason.trim().length < 3} onClick={() => lastOwn && void send({ action: 'undo', requestId: crypto.randomUUID(), undoEventId: lastOwn.id, expectedVersion: view.session.version, reason })} className={`${button} bg-chip`}>Undo my last counted unit</button><button disabled={busy || !!pending || !verified || !!view.order.blockedReason || reason.trim().length < 3} onClick={() => void send({ action: 'reset', requestId: crypto.randomUUID(), expectedVersion: view.session.version, reason })} className={`${button} bg-ink text-white`}>Start fresh · recount all {required} units</button></div></div>}
    <details className="my-5 rounded-card bg-white p-5"><summary className="cursor-pointer rounded-pill text-[14px] font-medium focus-visible:outline-2">Recent QC history · {view.events.length} events</summary><ol className="mt-4 grid gap-3">{view.events.map(event => <li key={event.id} className="border-b border-chip pb-3 text-[12px]"><div className="flex flex-wrap justify-between gap-2"><span>{event.actor_name} · {event.action} · checklist {event.generation}</span><time dateTime={event.created_at} className="text-ink-soft">{new Date(event.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} {time(event.created_at)}</time></div><p className="mt-1 text-ink-soft">{event.message}{event.code && ` · ${event.code}`}</p></li>)}</ol><p className="mt-3 text-[12px] text-ink-soft">Showing the most recent 40 events. Earlier checklists remain saved.</p></details>
  </section>
}
