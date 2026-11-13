'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ClubView, QcCommand, QcLine, QcView } from '@/lib/qc/types'
import { summarizeQc } from '@/lib/qc/summary'
import { playQcTone, vibrateQc, type QcTone } from '@/lib/qc/sound'
import { CameraScan } from './CameraScan'
import { button, feedbackFor, ReasonAction, type Feedback } from './QcScreen'

/**
 * Club QC (D168): the same customer's open orders on one screen with one scan field. Each order keeps its own
 * checklist; a scan goes to /api/qc/club/<order> and the server counts it in the oldest order that still needs the
 * piece. An order that already passed is shown ticked and is not scanned again. Recount lives on the single-order screen.
 */
const day = (value: string) => new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
const path = (gid: string) => gid.split('/').pop()!
interface Pending { url: string; command: QcCommand }

function state(view: QcView) {
  const stale = view.session.status === 'stale'
  const passed = view.session.status === 'passed'
  const lines = stale ? view.order.lines : view.session.snapshot.lines
  const wrap = summarizeQc(view.session, view.events, view.shortages)
  const required = lines.reduce((sum, line) => sum + line.required, 0)
  const checked = stale ? 0 : lines.reduce((sum, line) => sum + (view.session.counts[line.id] ?? 0), 0)
  const short = stale ? 0 : view.shortages.reduce((sum, item) => sum + item.quantity, 0)
  return { view, stale, passed, lines, wrap, required, checked, short, open: !stale && !passed && !view.order.blockedReason }
}

export function ClubQcScreen({ initialClub }: { initialClub: ClubView }) {
  const [club, setClub] = useState(initialClub)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<(Feedback & { order: string }) | null>(null)
  const [verified, setVerified] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const sequence = useRef(0)
  const queue = useRef<string[]>([])
  const [queued, setQueued] = useState(0)
  const cameraOpen = useRef(false)
  const cameraOpenChanged = useCallback((open: boolean) => { cameraOpen.current = open }, [])
  const anchor = path(club.anchorId)
  const pendingKey = `loupe.qc.pending.club.${club.operatorId}.${club.anchorId}`
  const signal = (tone: QcTone) => { void playQcTone(tone); vibrateQc(tone) }
  const merge = (view: QcView) => setClub(current => ({ ...current, members: current.members.map(member => member.order.id === view.order.id ? view : member) }))

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    const seq = ++sequence.current
    try {
      const response = await fetch(`/api/qc/club/${anchor}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not refresh the club.')
      if (seq !== sequence.current) return
      setClub(payload); setVerified(true); setError(null)
    } catch (cause) {
      if (seq !== sequence.current) return
      setVerified(false); setError(cause instanceof Error ? cause.message : 'Connection interrupted. Refresh before scanning.')
    }
  }, [anchor])

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(pendingKey)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a browser-only saved request, read after SSR.
      if (saved) { setPending(JSON.parse(saved)); setNotice('A previous request has no confirmed response. Retry it before scanning another unit.') }
    } catch { sessionStorage.removeItem(pendingKey) }
    void refresh()
    input.current?.focus({ preventScroll: true })
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000)
    const catchUp = () => { if (document.visibilityState === 'visible') void refresh() }
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
  }, [pendingKey, refresh])

  async function post(url: string, command: QcCommand): Promise<QcView> {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || 'QC could not confirm this request. Retry it.')
    return payload as QcView
  }

  /** One saved request at a time; a lost answer is retried with the same request id, so a unit is never counted twice. */
  async function send(url: string, command: QcCommand) {
    if (inFlight.current) return
    inFlight.current = true; sequence.current++; setBusy(true); setPending({ url, command }); setError(null)
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify({ url, command }))
      const view = await post(url, command)
      merge(view); setVerified(true)
      sessionStorage.removeItem(pendingKey); setPending(null)
      const said = `${view.replayed ? 'Saved request confirmed. ' : ''}${view.event?.message ?? 'QC saved.'}`
      // A refused scan, an extra or a conflict must read as a warning, not as the usual grey line.
      if (['accepted', 'passed', 'undone', 'removed', 'short'].includes(view.event?.outcome ?? '')) setNotice(said); else { setNotice(null); setError(said) }
      const next = feedbackFor(view)
      if (next) { signal(next.tone); setFeedback({ ...next, order: view.order.name }) }
    } catch (cause) {
      signal('reject')
      setError(cause instanceof Error ? cause.message : 'No confirmed response. Retry this request before scanning another unit.')
    } finally {
      inFlight.current = false; setBusy(false); if (!cameraOpen.current) input.current?.focus({ preventScroll: true })
      const next = queue.current.shift(); setQueued(queue.current.length)
      if (next) queueMicrotask(() => submitCode(next))
    }
  }

  const members = club.members.map(state)
  const open = members.filter(member => member.open)
  const allPassed = members.every(member => member.passed)
  const required = members.reduce((sum, member) => sum + member.required, 0)
  const checked = members.reduce((sum, member) => sum + member.checked, 0)
  const shortTotal = members.reduce((sum, member) => sum + member.short, 0)
  const openShort = open.reduce((sum, member) => sum + member.short, 0)
  const blocked = busy || !!pending || !verified
  const canConfirm = !blocked && open.length > 0 && open.every(member => member.wrap.canPass)

  function submitCode(scanned: string): boolean {
    const trimmed = scanned.trim()
    if (!trimmed) return false
    if (inFlight.current) {
      // The gun fires faster than a round trip: each code is sent in order after the current one confirms.
      if (queue.current.length >= 20) return false
      queue.current.push(trimmed); setQueued(queue.current.length)
      return true
    }
    if (blocked) return false
    if (!/^[\x21-\x7e]{1,64}$/.test(trimmed)) { signal('reject'); setError('Scan a barcode or SKU of 1–64 characters.'); return false }
    void send(`/api/qc/club/${anchor}`, { action: 'scan', requestId: crypto.randomUUID(), code: trimmed })
    return true
  }
  // Only the form empties the field, as the scan leaves: see QcScreen.
  function scan(event: FormEvent) { event.preventDefault(); if (submitCode(code)) setCode('') }

  /** Passes every unfinished order, oldest first. Each pass tells the bot about that order's missing pieces. */
  async function confirm() {
    if (inFlight.current || !canConfirm) return
    inFlight.current = true; sequence.current++; setBusy(true); setError(null)
    const said: string[] = []
    try {
      for (const member of open) {
        const view = await post(`/api/qc/${path(member.view.order.id)}`, { action: 'complete', requestId: crypto.randomUUID(), expectedVersion: member.view.session.version })
        merge(view)
        if (view.event?.outcome !== 'passed') throw new Error(`${view.order.name}: ${view.event?.message ?? 'QC did not pass.'}`)
        if (view.botNotice) said.push(view.botNotice)
      }
      signal('passed'); setFeedback(null); setNotice(['QC passed for the whole club.', ...said].join(' '))
    } catch (cause) {
      signal('reject'); setError(cause instanceof Error ? cause.message : 'QC could not be confirmed. Press Confirm QC again.')
    } finally { inFlight.current = false; setBusy(false) }
  }

  function renderLine(member: ReturnType<typeof state>, line: QcLine, locked: boolean) {
    const count = member.stale ? 0 : member.view.session.counts[line.id] ?? 0
    const short = member.stale ? 0 : member.wrap.shortByLine[line.id] ?? 0
    const settled = count + short === line.required
    const image = member.view.order.lines.find(item => item.id === line.id)?.image ?? line.image ?? null
    return <article key={line.id} className={`flex min-h-24 items-center gap-3 rounded-panel border bg-white p-3 ${settled ? 'border-line' : 'border-transparent'}`}>
      {image
        // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail.
        ? <img src={image} alt="" className={`h-16 w-16 shrink-0 rounded-tile bg-chip object-cover ${settled ? 'opacity-50' : ''}`} />
        : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-tile bg-chip text-[13px] text-ink-soft">No image</div>}
      <div className="min-w-0 flex-1"><h4 className={`text-[15px] font-medium ${settled ? 'text-ink-soft' : ''}`}>{count === line.required && '✓ '}{line.title}</h4><p className="text-[15px] text-ink-soft">{line.variantTitle || 'One option'}</p><p className="mt-1 break-all font-mono text-[13px]">{line.barcode || line.sku || 'No saved code'}</p>
        {!locked && !settled && <div className="mt-2"><ReasonAction label={`Don’t have it · mark ${line.required - count - short} missing`} confirm="Mark missing" disabled={blocked} onConfirm={reason => void send(`/api/qc/${path(member.view.order.id)}`, { action: 'short', requestId: crypto.randomUUID(), lineId: line.id, expectedVersion: member.view.session.version, reason })} /></div>}
      </div>
      <div className="shrink-0 text-right"><p className="text-[22px] font-medium tabular-nums">{count}<span className="text-[15px] text-ink-soft"> / {line.required}</span></p><p className="text-[13px] text-ink-soft">{count === line.required ? 'Checked' : settled ? `${short} missing` : `${line.required - count - short} to scan${short > 0 ? ` · ${short} missing` : ''}`}</p>
        {!locked && !settled && (line.barcode || line.sku) && <button type="button" disabled={blocked && !busy} onClick={() => submitCode(line.barcode || line.sku || '')} title="Use when the QR is cut or will not read; counts one unit exactly like a scan" className={`${button} mt-1 bg-chip`}>By hand</button>}
      </div>
    </article>
  }

  function renderMember(member: ReturnType<typeof state>) {
    const { view } = member
    const solo = `/qc/${path(view.order.id)}?solo=1`
    const pill = member.passed ? ['bg-green text-white', `✓ QC done · ${day(view.session.completed_at ?? view.session.checked_at)}`]
      : member.stale ? ['bg-amber text-black', 'Recount needed'] : view.order.blockedReason ? ['bg-amber text-black', 'Blocked'] : ['bg-ink text-white', `${member.checked} / ${member.required}`]
    const head = <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex flex-wrap items-center gap-2 text-[20px] font-medium">{view.order.name}{view.order.fulfillmentStatus === 'ON_HOLD' && <span className="rounded-pill bg-amber px-2.5 py-1 text-[15px] font-semibold text-black">Hold</span>}<span className={`rounded-pill px-3 py-1 text-[15px] ${pill[0]}`}>{pill[1]}</span>{member.short > 0 && <span className="rounded-pill bg-chip px-3 py-1 text-[15px]">{member.short} missing</span>}</h3><Link href={solo} className="inline-flex min-h-11 items-center text-[15px] underline">Open alone</Link></div>
    if (member.passed) return <details key={view.order.id} className="rounded-card border border-green/30 bg-surface p-3 md:p-4" data-club-member="passed">
      <summary className="cursor-pointer list-none">{head}<p className="mt-1 text-[15px] text-ink-soft">Already checked; nothing to scan. Tap to see its {member.lines.length} item{member.lines.length === 1 ? '' : 's'}.</p></summary>
      <div className="mt-3 space-y-2">{member.lines.map(line => renderLine(member, line, true))}</div>
    </details>
    if (!member.open) return <section key={view.order.id} className="rounded-card border-2 border-amber bg-surface p-3 md:p-4" data-club-member="attention">{head}
      <p className="mt-2 text-[15px]">{view.order.blockedReason ?? 'This order changed in Shopify after it was checked. Open it alone, start a fresh checklist and recount it.'}</p>
      <Link href={solo} className={`${button} mt-3 inline-flex items-center bg-ink text-white`}>Open {view.order.name} alone →</Link>
    </section>
    const toScan = member.lines.filter(line => (view.session.counts[line.id] ?? 0) + (member.wrap.shortByLine[line.id] ?? 0) < line.required)
    return <section key={view.order.id} className="rounded-card bg-surface p-3 md:p-4" data-club-member="open">{head}
      {member.wrap.extras.length > 0 && <div className="mt-3 space-y-2">{member.wrap.extras.map(item => <article key={item.eventId} className={`flex flex-wrap items-center justify-between gap-2 rounded-panel p-3 ${item.removed ? 'bg-chip' : 'bg-amber text-black'}`}>
        <div className="min-w-0"><h4 className={`break-all text-[16px] font-medium ${item.removed ? 'line-through' : ''}`}>{item.title}</h4><p className="text-[15px]">{item.kind === 'wrong' ? 'Not on any unfinished order of this club' : 'Extra unit'}</p></div>
        {item.removed ? <p className="text-[15px] font-medium">✓ Removed</p> : <button disabled={blocked} onClick={() => void send(`/api/qc/${path(view.order.id)}`, { action: 'clear_extra', requestId: crypto.randomUUID(), extraEventId: item.eventId, expectedVersion: view.session.version })} className={`${button} bg-ink text-white`}>Tick — removed</button>}
      </article>)}</div>}
      {view.shortages.length > 0 && <div className="mt-3 space-y-2">{view.shortages.map(item => <article key={item.id} className="rounded-panel border border-amber p-3">
        <h4 className="text-[16px] font-medium">Missing · {item.title}</h4><p className="text-[15px]">{item.variant_title || 'One option'} · {item.quantity} missing · {item.reason}</p><div className="mt-2"><ReasonAction label="Undo missing" confirm="Undo" disabled={blocked} onConfirm={reason => void send(`/api/qc/${path(view.order.id)}`, { action: 'undo', requestId: crypto.randomUUID(), undoEventId: item.event_id, expectedVersion: view.session.version, reason })} /></div>
      </article>)}</div>}
      <div className="mt-3 space-y-2">{toScan.map(line => renderLine(member, line, false))}{member.lines.filter(line => !toScan.includes(line)).map(line => renderLine(member, line, false))}</div>
    </section>
  }

  const attention = [error, cameraError].filter(Boolean)
  return <section className="h-full min-h-0 min-w-0 overflow-auto md:grid md:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.3fr)] md:gap-4 md:overflow-hidden" aria-label="Club QC checklist">
    <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-card bg-surface p-3 md:overflow-y-auto md:p-4 xl:gap-3">
      <div className="flex items-center justify-between gap-2"><Link href="/qc" className="inline-flex min-h-11 items-center rounded-pill text-[15px] underline">← Order QC</Link><Link href="/qc/shortages" className="inline-flex min-h-11 items-center rounded-pill px-3 text-[15px] underline">Shortages</Link></div>
      <div><p className="text-[15px] font-semibold text-ink-soft">CLUB · {club.members.length} orders · {club.customer}</p>
        <h1 className="text-[24px] font-medium tracking-[-0.025em]">{club.members.map(member => member.order.name.replace(/\D/g, '')).join(' + ')}</h1>
        <div className="mt-3 flex items-end justify-between gap-2"><p className="text-[36px] leading-none font-medium tabular-nums">{checked} <span className="text-[22px] text-ink-soft">/ {required}</span></p><p className="text-right text-[15px] text-ink-soft">checked{shortTotal > 0 && <span className="block">{shortTotal} missing</span>}</p></div>
        <progress aria-label="Units checked" value={checked} max={Math.max(1, required)} className="mt-2 block h-2 w-full overflow-hidden rounded-pill accent-green [&::-webkit-progress-bar]:bg-chip [&::-webkit-progress-value]:bg-green" />
      </div>
      {allPassed && <div role="status" className="rounded-panel bg-green p-5 text-white"><h2 className="text-[24px] font-medium leading-tight">QC passed · all {club.members.length} orders</h2><p className="mt-3 text-[15px]">Pack them in one parcel.{shortTotal > 0 && ` ${shortTotal} unit(s) are missing; follow up under Shortages.`} Fulfil in Shopify after packing.</p><Link href="/qc" className={`${button} mt-4 inline-flex items-center bg-white text-ink`}>Back to order list →</Link></div>}
      <form onSubmit={scan} className="flex items-end gap-2"><label className="grid min-w-0 flex-1 gap-1 text-[15px]" htmlFor="qc-code">Scan or type the SKU<input ref={input} id="qc-code" value={code} onChange={event => setCode(event.target.value)} readOnly={blocked && !busy} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="Scan or type SKU" className="min-h-11 min-w-0 rounded-pill bg-chip px-4 py-2.5 font-mono text-[16px] focus:outline-2 focus:outline-ink" /></label><button disabled={(blocked && !busy) || !code.trim()} className={`${button} shrink-0 bg-ink text-white`}>Check ↵</button></form>
      <div className="flex items-center justify-between gap-2 text-[15px] text-ink-soft"><span>{busy ? (queued > 0 ? `${queued} waiting · keep scanning` : 'Checking…') : verified ? 'Shopify verified' : 'Verifying Shopify…'}</span><button disabled={busy || !!pending} onClick={() => void refresh()} className={`${button} px-2 underline`}>Refresh</button></div>
      <div className={`min-h-[72px] shrink-0 rounded-panel p-3 text-[16px] leading-snug ${attention.length ? 'bg-amber text-black' : 'bg-chip text-ink'}`} role={attention.length ? 'alert' : 'status'} aria-live={attention.length ? 'assertive' : 'polite'} aria-atomic="true">
        {attention.length ? attention.map(message => <p key={message}>{message}</p>) : <p>{notice || 'Scan a pouch. It is counted in the oldest order that still needs it.'}</p>}
        {pending && !busy && <button onClick={() => void send(pending.url, pending.command)} className={`${button} mt-2 bg-ink text-white`}>Retry the same request safely</button>}
      </div>
      {!allPassed && <div className="min-h-0 space-y-2 md:flex-1 md:overflow-auto">
        {feedback && <div className={`flex items-center gap-3 rounded-panel border-2 p-2 ${feedback.tone === 'reject' ? 'border-amber' : 'border-green'}`}>
          {feedback.image
            // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnail of the scanned line.
            ? <img src={feedback.image} alt="" className="h-24 w-24 shrink-0 rounded-tile bg-chip object-cover" />
            : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-tile bg-chip text-[15px] text-ink-soft">No image</div>}
          <div className="min-w-0"><p className="text-[18px] font-medium">{feedback.headline} · {feedback.order}</p>{feedback.progress && <p className="text-[20px] tabular-nums">{feedback.progress}</p>}{feedback.title && <p className="line-clamp-2 text-[15px]">{feedback.title} · {feedback.variantTitle || 'One option'}</p>}{feedback.code && !feedback.title && <p className="break-all font-mono text-[15px]">{feedback.code}</p>}</div>
        </div>}
        <CameraScan paused={blocked} onCode={submitCode} onOpenChange={cameraOpenChanged} onErrorChange={setCameraError} />
      </div>}
      {!allPassed && <div className="mt-auto grid shrink-0 gap-2">
        <button disabled={!canConfirm} onClick={() => void confirm()} className={`${button} bg-ink text-white`}>{`Confirm QC · ${open.length} order${open.length === 1 ? '' : 's'}${openShort > 0 ? ` · ${openShort} missing` : ''}`}</button>
        <p className="text-[13px] text-ink-soft">Scan every piece or mark it missing first. Missing pieces go to WhatsApp for the coupon. To recount an order, open it alone.</p>
      </div>}
    </div>
    <div className="min-h-0 min-w-0 space-y-4 pt-4 pb-4 md:overflow-y-auto md:overscroll-contain md:pt-0">{members.map(renderMember)}</div>
  </section>
}
