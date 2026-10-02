'use client'

import Link from 'next/link'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { QcCommand, QcView } from '@/lib/qc/types'
import { parseQcCommand } from '@/lib/qc/validation'
import { summarizeQc } from '@/lib/qc/summary'
import { playQcTone, toneForOutcome, vibrateQc, type QcTone } from '@/lib/qc/sound'
import { CameraScan } from './CameraScan'

const button = 'min-h-11 min-w-11 rounded-pill px-4 py-2.5 text-[15px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40'
// One identity for the whole module: an inline ref callback runs again on every render and would pull focus back from the scan field.
const focusWithoutScroll = (node: HTMLInputElement | null) => { node?.focus({ preventScroll: true }) }
const time = (value: string) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })

interface Feedback { tone: QcTone; headline: string; message: string; image: string | null; title: string | null; variantTitle: string | null; progress: string | null; code: string | null }

/** What the last action deserves on the feedback card, or null when the view carries no outcome worth a tone. */
function feedbackFor(payload: QcView): Feedback | null {
  const outcome = payload.event?.outcome
  const tone = toneForOutcome(outcome)
  if (!tone) return null
  const line = payload.session.snapshot.lines.find(item => item.id === payload.event?.line_id) ?? payload.session.snapshot.lines.find(item => payload.event?.variant_id != null && item.variantId === payload.event?.variant_id)
  const fresh = line && payload.order.lines.find(item => item.id === line.id)
  const count = line ? payload.session.counts[line.id] ?? 0 : null
  return {
    tone,
    headline: outcome === 'accepted' ? '✓ Checked' : outcome === 'passed' ? '✓ QC passed' : outcome === 'short' ? 'Marked short' : outcome === 'removed' ? '✓ Extra removed' : outcome === 'extra' ? 'Extra unit' : outcome === 'wrong' ? 'Not on this order' : outcome === 'rejected' ? 'Not accepted' : 'Check the message',
    message: payload.event?.message ?? '',
    image: fresh?.image ?? line?.image ?? null, title: line?.title ?? null, variantTitle: line?.variantTitle ?? null,
    progress: line && count !== null ? `${count} / ${line.required}` : null,
    code: payload.event?.code ?? null,
  }
}

/** A small inline "reason, then confirm" control; every count-changing correction needs an audit reason. */
function ReasonAction({ label, confirm, disabled, onConfirm }: { label: string; confirm: string; disabled: boolean; onConfirm: (reason: string) => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={`${button} bg-white border border-chip`}>{label}</button>
  return <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (reason.trim().length >= 3) { onConfirm(reason.trim()); setOpen(false); setReason('') } }}>
    <input aria-label="Reason for shortage correction" ref={focusWithoutScroll} value={reason} onChange={event => setReason(event.target.value)} maxLength={240} placeholder="Reason (for example: not in stock)" className="min-h-11 min-w-0 rounded-pill bg-chip px-4 py-2 text-[16px] focus:outline-2 focus:outline-ink" />
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
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState('')
  const [notice, setNotice] = useState<{ text: string; attention: boolean } | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(() => feedbackFor(initialView))
  const [verified, setVerified] = useState(false)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [reason, setReason] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const screen = useRef<HTMLElement>(null)
  const itemsPane = useRef<HTMLDivElement>(null)
  const [minimumItemsHeight, setMinimumItemsHeight] = useState(0)
  const savedScroll = useRef<{ node: HTMLElement; top: number }[]>([])
  const applyView = useCallback((payload: QcView) => {
    savedScroll.current = [screen.current, itemsPane.current].filter((node): node is HTMLElement => node !== null).map(node => ({ node, top: node.scrollTop }))
    const pane = itemsPane.current
    // Keep enough space below the viewport when regrouping/removing rows at the bottom.
    if (pane && window.matchMedia('(min-width: 768px)').matches) setMinimumItemsHeight(pane.scrollTop + pane.clientHeight)
    setView(payload)
  }, [])
  useLayoutEffect(() => {
    for (const { node, top } of savedScroll.current) node.scrollTo({ top, behavior: 'instant' })
    savedScroll.current = []
  }, [view])
  const cameraOpen = useRef(false)
  const cameraOpenChanged = useCallback((open: boolean) => { cameraOpen.current = open }, [])
  const inFlight = useRef(false)
  const sequence = useRef(0)
  // Codes the gun fired while a request was in flight; drained one at a time after each confirmed response.
  const queue = useRef<string[]>([])
  const [queued, setQueued] = useState(0)
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
      applyView(payload); setVerified(true); setRefreshError(null)
    } catch (cause) {
      if (seq !== sequence.current) return
      setVerified(false); setRefreshError(cause instanceof Error ? cause.message : 'Connection interrupted. Refresh before scanning.')
    }
  }, [endpoint, applyView])

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
    input.current?.focus({ preventScroll: true })
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000)
    const catchUp = () => { if (document.visibilityState === 'visible') { setVerified(false); void refresh() } }
    // A 2D scanner gun types into whatever is focused: pull stray keystrokes back into the code field.
    const capture = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (!editable && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !cameraOpen.current) input.current?.focus({ preventScroll: true })
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
      applyView(payload); setVerified(true)
      sessionStorage.removeItem(pendingKey); setPending(null); setCode(''); setReason(''); setResetOpen(false); setRecoveryRequired(false)
      const outcome = payload.event?.outcome
      setNotice({ text: `${payload.replayed ? 'Saved request confirmed. ' : ''}${payload.event?.message ?? 'QC saved.'}`, attention: !['accepted', 'passed', 'undone', 'reset', 'removed', 'short'].includes(outcome ?? '') })
      const next = command.action === 'reset' ? null : feedbackFor(payload)
      if (next) { signal(next.tone); setFeedback(next) }
    } catch (cause) {
      signal('reject')
      setError(cause instanceof Error ? cause.message : 'No confirmed response. Retry this request before scanning another unit.')
    } finally {
      inFlight.current = false; setBusy(false); if (!cameraOpen.current) input.current?.focus({ preventScroll: true })
      const next = queue.current.shift(); setQueued(queue.current.length)
      if (next) queueMicrotask(() => submitCode(next))
    }
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
    const trimmed = scannedCode.trim()
    if (!trimmed) return
    if (inFlight.current && !recoveryRequired && !stale && !view.order.blockedReason) {
      // The gun fires faster than a round trip: keep scanning, each code is sent in order after the current one confirms.
      if (queue.current.length < 20) { queue.current.push(trimmed); setQueued(queue.current.length); setCode('') }
      return
    }
    if (blocked) return
    try { void send(parseQcCommand({ action: 'scan', requestId: crypto.randomUUID(), code: trimmed, expectedGeneration: view.session.generation })) }
    catch (cause) { signal('reject'); setError(cause instanceof Error ? cause.message : 'Scan a valid code.'); if (!cameraOpen.current) { input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(0, input.current.value.length) } }
  }

  function scan(event: FormEvent) { event.preventDefault(); submitCode(code) }

  const toScan = lines.filter(line => (stale ? 0 : (view.session.counts[line.id] ?? 0) + (wrap.shortByLine[line.id] ?? 0)) < line.required)
  const settledLines = lines.filter(line => !toScan.includes(line))
  const attention = [...new Set([
    view.order.blockedReason,
    stale ? 'Order changed. Start a fresh checklist and recount every unit; previous counts are saved in history.' : null,
    error, refreshError, cameraError,
    notice?.attention ? notice.text : !notice && feedback?.tone === 'reject' ? feedback.message : null,
  ].filter((message): message is string => !!message))]
  const hasAttention = !stale && (wrap.missing.length > 0 || wrap.extras.length > 0 || view.shortages.length > 0)
  const destination = view.order.fulfillmentStatus === 'ON_HOLD' ? 'put this box in the HOLD box' : 'ready to ship'

  function renderLine(line: typeof lines[number]) {
    const count = stale ? 0 : view.session.counts[line.id] ?? 0
    const short = stale ? 0 : wrap.shortByLine[line.id] ?? 0
    const done = count === line.required
    const settled = count + short === line.required
    const image = images.get(line.id) ?? line.image ?? null
    return <article key={line.id} className={`flex min-h-28 items-center gap-3 rounded-panel border bg-white p-3 ${settled ? 'border-line' : 'border-transparent'}`}>
      {image
        // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail.
        ? <img src={image} alt="" className={`h-[72px] w-[72px] shrink-0 rounded-tile bg-chip object-cover ${settled ? 'opacity-50' : ''}`} />
        : <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-tile bg-chip text-[15px] text-ink-soft">No image</div>}
      <div className="min-w-0 flex-1"><h3 className={`text-[15px] font-medium ${settled ? 'text-ink-soft' : ''}`}>{done && '✓ '}{line.title}</h3><p className="text-[15px] text-ink-soft">{line.variantTitle || 'One option'}</p><p className="mt-1 break-all font-mono text-[13px] md:text-[15px]">{line.barcode || line.sku || 'No saved code'}</p>
        {!line.barcode && <Link href={line.sku ? `/labels?q=${encodeURIComponent(line.sku)}` : '/labels'} className="mt-1 inline-flex min-h-11 items-center rounded-pill text-[15px] underline">Barcode missing · prepare labels</Link>}
      </div>
      <div className="shrink-0 text-right"><p className="text-[24px] font-medium tabular-nums">{count}<span className="text-[15px] text-ink-soft"> / {line.required}</span></p><p className="text-[13px] text-ink-soft md:text-[15px]">{done ? 'Checked' : short > 0 && settled ? `${short} short · accepted` : `${line.required - count - short} to scan${short > 0 ? ` · ${short} short` : ''}`}</p>
        {!settled && (line.barcode || line.sku) && <button type="button" disabled={blocked && !busy} onClick={() => submitCode(line.barcode || line.sku || '')} title="Use when the QR is cut or will not read; counts one unit exactly like a scan" className={`${button} mt-1 bg-chip`}>By hand</button>}
      </div>
    </article>
  }

  return <section ref={screen} className="h-full min-h-0 min-w-0 overflow-auto [overflow-anchor:none] md:grid md:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.3fr)] md:gap-4 md:overflow-hidden" aria-label="Order QC checklist">
    <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-card bg-surface p-3 md:overflow-y-auto md:p-4 xl:gap-3" data-qc-controls>
      <div className="flex items-center justify-between gap-2"><Link href="/qc" className="inline-flex min-h-11 items-center rounded-pill text-[15px] underline">← Order QC</Link><Link href="/qc/shortages" className="inline-flex min-h-11 items-center rounded-pill px-3 text-[15px] underline">Shortages</Link></div>
      <div><h1 className="flex flex-wrap items-center gap-2 text-[26px] font-medium tracking-[-0.025em]">{view.order.name}{view.order.fulfillmentStatus === 'ON_HOLD' && <span className="rounded-pill bg-amber px-3 py-1 text-[15px] font-semibold text-black">Hold</span>}</h1>
        <div className="mt-3 flex items-end justify-between gap-2"><p className="text-[36px] leading-none font-medium tabular-nums">{checked} <span className="text-[22px] text-ink-soft">/ {required}</span></p><p className="text-right text-[15px] text-ink-soft">checked{shortTotal > 0 && <span className="block">{shortTotal} accepted short</span>}</p></div>
        <progress aria-label="Units checked" value={checked} max={Math.max(1, required)} className="mt-2 block h-2 w-full overflow-hidden rounded-pill accent-green [&::-webkit-progress-bar]:bg-chip [&::-webkit-progress-value]:bg-green" />
      </div>
      {!passed && <p className="text-[15px] text-ink-soft">Scan a pouch, then box it.</p>}
      {passed && <div role="status" className="rounded-panel bg-green p-5 text-white">
        <h2 className="text-[24px] font-medium leading-tight">QC passed · {destination}</h2>
        <p className="mt-3 text-[15px]">Checked at {time(view.session.completed_at!)}. Extra items were confirmed removed.{shortTotal > 0 && ` ${shortTotal} unit(s) accepted as short; follow up under Shortages for refund or coupon.`} Fulfil in Shopify after packing. Order changes require a new check.</p>
        <Link href="/qc" className={`${button} mt-4 inline-flex items-center bg-white text-ink`}>Back to order list →</Link>
      </div>}
      {/* The scan field stays after a pass: a pouch scanned then is recorded as an extra to remove. */}
      <>
        <form onSubmit={scan} className="flex items-end gap-2"><label className="grid min-w-0 flex-1 gap-1 text-[15px]" htmlFor="qc-code">Scan or type the SKU<input ref={input} id="qc-code" value={code} onChange={event => setCode(event.target.value)} readOnly={blocked && !busy} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="Scan or type SKU" className="min-h-11 min-w-0 rounded-pill bg-chip px-4 py-2.5 font-mono text-[16px] focus:outline-2 focus:outline-ink" /></label><button disabled={(blocked && !busy) || !code.trim()} className={`${button} shrink-0 bg-ink text-white`}>Check ↵</button></form>
        {!passed && <div className="flex items-center justify-between gap-2 text-[15px] text-ink-soft"><span>{busy ? (queued > 0 ? `${queued} waiting · keep scanning` : 'Checking…') : verified ? 'Shopify verified' : 'Verifying Shopify…'}{view.timings && <span className="block text-[13px] md:text-[15px]">Last check {(view.timings.totalMs / 1000).toFixed(2)} s</span>}</span><button disabled={busy || !!pending} onClick={() => void refresh()} className={`${button} px-2 underline`}>Refresh</button></div>}
      </>
      <div className={`min-h-[72px] shrink-0 rounded-panel p-3 text-[16px] leading-snug ${attention.length ? 'bg-amber text-black' : 'bg-chip text-ink'}`} role={attention.length ? 'alert' : 'status'} aria-live={attention.length ? 'assertive' : 'polite'} aria-atomic="true" data-qc-message>
        {attention.length ? attention.map(message => <p key={message}>{message}</p>) : <p>{notice?.text || (passed ? 'QC saved.' : 'Ready for the next pouch.')}</p>}
        {pending && !busy && <button onClick={() => void send(pending)} className={`${button} mt-2 bg-ink text-white`}>Retry the same request safely</button>}
      </div>
      {!passed && <div className="min-h-0 space-y-2 md:flex-1 md:overflow-auto [overflow-anchor:none]" data-qc-scan-details>
        {feedback && <div className={`flex items-center gap-3 rounded-panel border-2 p-2 ${feedback.tone === 'reject' ? 'border-amber' : 'border-green'}`}>
          {feedback.image
            // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail of the scanned line.
            ? <img src={feedback.image} alt="" className="h-24 w-24 shrink-0 rounded-tile bg-chip object-cover" />
            : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-tile bg-chip text-[15px] text-ink-soft">No image</div>}
          <div className="min-w-0"><p className="text-[18px] font-medium">{feedback.headline}</p>{feedback.progress && <p className="text-[20px] tabular-nums">{feedback.progress}</p>}{feedback.title && <p className="line-clamp-2 text-[15px]">{feedback.title} · {feedback.variantTitle || 'One option'}</p>}{feedback.code && !feedback.title && <p className="break-all font-mono text-[15px]">{feedback.code}</p>}</div>
        </div>}
        <CameraScan paused={blocked || resetOpen} onCode={submitCode} onOpenChange={cameraOpenChanged} onErrorChange={setCameraError} />
      </div>}
      <div className="mt-auto grid shrink-0 gap-2">
        {!passed && <button disabled={blocked || !wrap.canPass} onClick={() => void send({ action: 'complete', requestId: crypto.randomUUID(), expectedVersion: view.session.version })} className={`${button} bg-ink text-white`}>{shortTotal > 0 ? `Complete QC · ${shortTotal} short` : 'Complete QC'}</button>}
        <button disabled={busy || !!pending} onClick={() => { setResetOpen(!resetOpen); setReason('') }} className={`${button} bg-chip`}>Recount / undo</button>
      </div>
    </div>
    <div ref={itemsPane} className="min-h-0 min-w-0 pt-4 [overflow-anchor:none] md:overflow-y-auto md:overscroll-contain md:pt-0" data-qc-items>
      <div style={{ '--qc-items-min-height': `${minimumItemsHeight}px` } as CSSProperties} className="space-y-4 pb-4 md:min-h-[var(--qc-items-min-height)]">
        {hasAttention && <section aria-labelledby="qc-attention-heading" className="rounded-card border-2 border-amber bg-surface p-4">
          <h2 id="qc-attention-heading" className="text-[18px] font-medium">Needs attention</h2>
          {wrap.extras.length > 0 && <div className="mt-3 space-y-2">{wrap.extras.map(item => <article key={item.eventId} className={`flex flex-wrap items-center justify-between gap-2 rounded-panel p-3 ${item.removed ? 'bg-chip' : 'bg-amber text-black'}`}>
            <div className="min-w-0"><h3 className={`break-all text-[16px] font-medium ${item.removed ? 'line-through' : ''}`}>{item.title}</h3><p className="text-[15px]">{item.kind === 'wrong' ? 'Not on this order' : 'Extra unit of a listed variant'}</p></div>
            {item.removed ? <p className="text-[15px] font-medium">✓ Removed</p> : <button disabled={actionsBlocked} onClick={() => void send({ action: 'clear_extra', requestId: crypto.randomUUID(), extraEventId: item.eventId, expectedVersion: view.session.version })} className={`${button} bg-ink text-white`}>Tick — removed</button>}
          </article>)}</div>}
          {wrap.missing.length > 0 && <details className="mt-3 rounded-panel bg-chip p-3"><summary className="min-h-11 cursor-pointer content-center rounded-pill text-[16px] font-medium">Missing items · {wrap.missing.reduce((sum, item) => sum + item.remaining, 0)} units · mark short</summary>
            <p className="mt-2 text-[15px] text-ink-soft">Scan these below, or accept a shortage with a reason if the item is unavailable.</p>
            <div className="mt-3 space-y-3">{wrap.missing.map(item => <article key={item.lineId} className="rounded-panel bg-white p-3">
              <h3 className="text-[16px] font-medium">{item.title} · {item.variantTitle || 'One option'}</h3><div className="mt-2"><ReasonAction label={`Don’t have it · mark ${item.remaining} short`} confirm="Mark short" disabled={actionsBlocked || !!view.order.blockedReason} onConfirm={reasonText => void send({ action: 'short', requestId: crypto.randomUUID(), lineId: item.lineId, expectedVersion: view.session.version, reason: reasonText })} /></div>
            </article>)}</div>
          </details>}
          {view.shortages.length > 0 && <div className="mt-3 space-y-2"><h3 className="text-[16px] font-medium">Accepted as short</h3>{view.shortages.map(item => <article key={item.id} className="rounded-panel border border-amber p-3">
            <h4 className="text-[16px] font-medium">#{item.ref} · {item.title}</h4><p className="text-[15px]">{item.variant_title || 'One option'} · {item.quantity} short · {item.reason}</p><div className="mt-2"><ReasonAction label="Undo shortage" confirm="Undo" disabled={actionsBlocked || !!view.order.blockedReason} onConfirm={reasonText => void send({ action: 'undo', requestId: crypto.randomUUID(), undoEventId: item.event_id, expectedVersion: view.session.version, reason: reasonText })} /></div>
          </article>)}</div>}
        </section>}
        <section aria-labelledby="qc-to-scan-heading"><h2 id="qc-to-scan-heading" className="mb-3 text-[20px] font-medium">To scan · {toScan.length}</h2><div className="space-y-2">{toScan.map(renderLine)}</div>{toScan.length === 0 && <p className="rounded-panel bg-white p-4 text-[15px]">All items are checked or accepted as short.</p>}</section>
        <section aria-labelledby="qc-checked-heading"><h2 id="qc-checked-heading" className="mb-3 text-[20px] font-medium text-ink-soft">Checked · {settledLines.length}</h2><div className="space-y-2">{settledLines.map(renderLine)}</div></section>
        <details className="rounded-card bg-surface p-4"><summary className="min-h-11 cursor-pointer content-center rounded-pill text-[16px] font-medium">Recent QC history · {view.events.length} events</summary><ol className="mt-4 space-y-3">{view.events.map(event => <li key={event.id} className="border-b border-chip pb-3 text-[15px]"><div className="flex flex-wrap justify-between gap-2"><span>{event.actor_name} · {event.action} · checklist {event.generation}</span><time dateTime={event.created_at} className="text-ink-soft">{new Date(event.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} {time(event.created_at)}</time></div><p className="mt-1 break-words text-ink-soft">{event.message}{event.code && ` · ${event.code}`}</p></li>)}</ol><p className="mt-3 text-[15px] text-ink-soft">Showing the most recent 40 events. Earlier checklists remain saved.</p></details>
      </div>
    </div>
    {resetOpen && <dialog ref={node => { if (node && !node.open) node.showModal() }} onCancel={() => setResetOpen(false)} onClose={() => setResetOpen(false)} aria-labelledby="qc-correction-title" className="fixed inset-0 m-auto max-h-[90dvh] w-[min(92vw,480px)] overflow-auto rounded-card bg-surface p-5 text-ink backdrop:bg-black/40">
      <h2 id="qc-correction-title" className="text-[20px] font-medium">Correct the checklist</h2><p className="mt-2 text-[15px] text-ink-soft">Undo one of your counted units, or start fresh. A fresh checklist clears counts and accepted shortages; earlier work stays in history.</p>
      <label className="mt-4 grid gap-2 text-[15px]">Reason<input ref={focusWithoutScroll} value={reason} onChange={event => setReason(event.target.value)} maxLength={240} placeholder="For example: repacking into a new box" className="min-h-11 rounded-pill bg-chip px-4 py-3 text-[16px] focus:outline-2 focus:outline-ink" /></label>
      <div className="mt-4 grid gap-2"><button disabled={blocked || !lastOwn || reason.trim().length < 3} onClick={() => lastOwn && void send({ action: 'undo', requestId: crypto.randomUUID(), undoEventId: lastOwn.id, expectedVersion: view.session.version, reason })} className={`${button} bg-chip`}>Undo my last counted unit</button><button disabled={busy || !!pending || !verified || !!view.order.blockedReason || reason.trim().length < 3} onClick={() => void send({ action: 'reset', requestId: crypto.randomUUID(), expectedVersion: view.session.version, reason })} className={`${button} bg-ink text-white`}>Start fresh · recount all {required} units</button><button onClick={() => setResetOpen(false)} className={`${button} bg-white`}>Cancel</button></div>
    </dialog>}
  </section>
}
