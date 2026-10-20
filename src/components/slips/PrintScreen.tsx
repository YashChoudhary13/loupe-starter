'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { retryProgressAction } from '@/app/(shell)/dispatch/print/actions'
import { AUTO_EVERY_MS } from '@/lib/slips/auto'
import { fmtWhen } from '@/lib/slips/render'
import type { Mark } from '@/lib/slips/types'

export interface PreviewRow { id: string; number: number; name: string; mark: Mark; detail: string; flags: string[]; how: string[]; customer: string; phone: string; city: string; units: number; status: string }
export interface PrintBatch { id: string; printedBy: string; printedAt: string; count: number; fromNumber: number | null; first: number | null; last: number | null; baseline: number; failed: { name: string; error: string }[] }
/** Auto print (?auto): whether the server's clock is before the dispatch cutoff, and when it read the orders. */
export interface AutoPrint { due: boolean; readAt: string }
export interface PrintScreenProps { rows: PreviewRow[]; leftOut: string[]; unprinted: number; truncated: boolean; oldest: number | null; batches: PrintBatch[]; error?: string; auto?: AutoPrint | null }

const pill = 'rounded-pill px-4 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40'
const MARK_CLASS: Record<Mark, string> = { PACK: 'text-ink', HOLD: 'text-amber', CLUB: 'text-ink', 'CLUB + HOLD': 'text-amber' }
const count = (rows: PreviewRow[], mark: Mark) => rows.filter(row => row.mark === mark).length
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Opens the browser's print dialog on a slip document from a hidden frame, so it appears over this page and nothing leaves
 * it (D152, the D139 pattern). The frame's load waits for every product photo; after 15 s the dialog opens anyway, since a
 * stalled photo once held a print (2026-10-07). */
function printDocument(html: string): Promise<void> {
  return new Promise(resolve => {
    document.getElementById('slip-print-frame')?.remove()
    const frame = document.createElement('iframe')
    frame.id = 'slip-print-frame'
    frame.title = 'Packing slips'
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    let done = false
    const go = () => { if (done) return; done = true; frame.contentWindow?.focus(); frame.contentWindow?.print(); resolve() }
    frame.onload = go
    setTimeout(go, 15_000)
    frame.srcdoc = html
    document.body.append(frame)
  })
}

export function PrintScreen({ rows, leftOut, unprinted, truncated, oldest, batches, error, auto = null }: PrintScreenProps) {
  const router = useRouter()
  const [from, setFrom] = useState('')
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'preparing' | 'printing'>('idle')
  const [note, setNote] = useState<string | null>(null)
  const fromNumber = Number(from.replace(/\D/g, '')) || null
  const printing = fromNumber ? rows.filter(row => row.number >= fromNumber) : rows
  const baseline = fromNumber ? rows.length - printing.length : 0
  const toPack = printing.filter(row => row.mark === 'PACK' || row.mark === 'CLUB').reduce((sum, row) => sum + row.units, 0)
  /** Fetches a slip document and prints it in place. The answer to a click that printed nothing is a note, shown here. */
  const printFrom = async (path: string, init?: RequestInit) => {
    setStage('preparing'); setNote(null)
    try {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      const body = await response.text()
      if (!response.ok) { setNote(body || 'Loupe could not print. Reload and try again.'); return }
      setStage('printing')
      await printDocument(body)
    } catch { setNote('Loupe could not be reached. Try again.') }
    finally { setStage('idle') }
  }
  const printAll = async () => {
    await printFrom('/api/slips', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ from }) })
    router.refresh() // the printed orders leave the list and the batch appears below, whatever the dialog did
  }
  const print = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return printAll() }
  /** Auto print: re-read the open orders on a timer, and print whatever the latest read lists while it is before the
   * dispatch cutoff. Each server refresh hands over a new rows array, so the second effect runs once per read, never
   * when a print merely finishes; a failed print is tried again on the next read. */
  useEffect(() => {
    if (!auto) return
    const timer = setInterval(() => router.refresh(), AUTO_EVERY_MS)
    return () => clearInterval(timer)
  }, [auto, router])
  useEffect(() => {
    if (auto?.due && rows.length > 0 && stage === 'idle' && !error && !truncated) void printAll() // eslint-disable-line react-hooks/set-state-in-effect -- the print is the effect of a new read
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps -- once per server read, see above
  const retry = (batchId: string) => {
    setBusy(batchId)
    retryProgressAction(batchId)
      .then(state => { setMessages(current => ({ ...current, [batchId]: state.message })); if (state.ok) router.refresh() })
      .catch(() => setMessages(current => ({ ...current, [batchId]: 'Loupe could not be reached. Try again.' })))
      .finally(() => setBusy(null))
  }

  return <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
    <h1 className="text-[26px] font-medium tracking-[-0.025em]">Print slips</h1>
    <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Every open paid order without a slip yet, marked PACK, HOLD, CLUB or CLUB + HOLD by the packing-list rules. Print opens the browser&apos;s print dialog here with one slip per order, records them, and marks the PACK and CLUB orders In progress in Shopify. Click again later and only new orders print.</p>
    {auto && <p role="status" className="mt-4 rounded-panel bg-white p-4 text-[13px]">Auto print on: this page re-reads the orders every {AUTO_EVERY_MS / 60_000} minutes and prints new slips here until 4:30 PM IST. Last read {auto.readAt} IST{auto.due ? '' : ', paused until tomorrow morning'}.</p>}
    {note && <p role="status" className="mt-4 rounded-panel bg-white p-4 text-[13px]">{note}</p>}
    {error && <p role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">{error}</p>}
    {truncated && <p role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">Shopify has more open orders than Loupe reads in one go, so this list is incomplete and Print is off. Archive old fulfilled orders in Shopify.</p>}

    <form method="post" action="/api/slips" onSubmit={print} className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">Not printed yet · {plural(rows.length, 'order')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-ink-soft">Print from Qimati
            <input name="from" inputMode="numeric" value={from} onChange={event => setFrom(event.target.value)} placeholder={oldest ? String(oldest) : ''} aria-label="First order number to print" className="w-24 rounded-pill bg-chip px-3 py-2 text-[13px] text-ink focus:outline-2 focus:outline-ink" /></label>
          <button type="submit" className={`${pill} bg-ink text-white`} disabled={truncated || !!error || printing.length === 0 || stage !== 'idle'}>{stage === 'preparing' ? 'Preparing…' : stage === 'printing' ? 'Printing…' : `Print ${plural(printing.length, 'slip')}`}</button>
        </div>
      </div>
      <p className="mt-2 text-[13px] text-ink-soft">
        {rows.length ? `PACK ${count(printing, 'PACK')} · CLUB ${count(printing, 'CLUB')} · HOLD ${count(printing, 'HOLD')} · CLUB + HOLD ${count(printing, 'CLUB + HOLD')} · ${toPack.toLocaleString('en-IN')} units to pack` : 'Every open paid order has a slip.'}
        {baseline > 0 && ` · ${plural(baseline, 'older order')} below Qimati${fromNumber} will be recorded as printed before Loupe and never print here.`}
        {unprinted !== rows.length && ` · ${unprinted} unprinted in Shopify`}
      </p>
      {leftOut.length > 0 && <p className="mt-2 text-[13px] text-amber">Left out, payment not received: {leftOut.join(', ')}</p>}
      {rows.length > 0 && <div className="mt-4 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead><tr className="text-left text-[11px] uppercase tracking-[0.04em] text-ink-soft"><th className="py-2 pr-3">Order</th><th className="py-2 pr-3">Mark</th><th className="py-2 pr-3">Customer</th><th className="py-2 pr-3">Phone</th><th className="py-2 pr-3">City</th><th className="py-2 pr-3 text-right">Units</th><th className="py-2 pr-3">Status</th></tr></thead>
          <tbody>{rows.map(row => {
            const skipped = fromNumber !== null && row.number < fromNumber
            return <tr key={row.id} className={`border-t border-chip align-top ${skipped ? 'opacity-40' : ''}`}>
              <td className="py-2 pr-3 whitespace-nowrap font-medium">{row.name}</td>
              <td className="py-2 pr-3"><b className={MARK_CLASS[row.mark]}>{row.mark}</b>{row.detail && <span className="text-ink-soft"> {row.detail}</span>}{row.flags.map(flag => <span key={flag} className="ml-2 rounded-[4px] bg-chip px-1.5 text-[11px]">{flag}</span>)}{row.how.length > 0 && row.mark !== 'PACK' && <div className="text-[11px] text-ink-soft">same {row.how.join(', ')}</div>}</td>
              <td className="py-2 pr-3">{row.customer}</td><td className="py-2 pr-3 whitespace-nowrap">{row.phone}</td><td className="py-2 pr-3">{row.city}</td><td className="py-2 pr-3 text-right tabular-nums">{row.units}</td><td className="py-2 pr-3 whitespace-nowrap">{row.status}</td>
            </tr>
          })}</tbody>
        </table>
      </div>}
    </form>

    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <h2 className="text-[15px] font-medium">Printed batches</h2>
      {batches.length === 0 && <p className="mt-2 text-[13px] text-ink-soft">Nothing printed from Loupe yet.</p>}
      <div className="mt-3 grid gap-3">{batches.map(batch => <div key={batch.id} className="rounded-panel border border-chip bg-white p-3 md:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[13px]"><span className="font-medium">{plural(batch.count, 'slip')}</span>{batch.first !== null && <span className="text-ink-soft"> · Qimati{batch.first}{batch.last !== batch.first && ` to Qimati${batch.last}`}</span>}<span className="text-ink-soft"> · {fmtWhen(batch.printedAt)} IST · {batch.printedBy}</span>{batch.baseline > 0 && <span className="text-ink-soft"> · {plural(batch.baseline, 'older order')} recorded as printed before Loupe</span>}</div>
          <div className="flex flex-wrap gap-2">
            {batch.failed.length > 0 && <button type="button" className={`${pill} bg-chip`} disabled={busy === batch.id} onClick={() => retry(batch.id)}>{busy === batch.id ? 'Marking…' : `Retry marking ${plural(batch.failed.length, 'order')}`}</button>}
            {batch.count > 0 && <button type="button" className={`${pill} bg-chip`} disabled={stage !== 'idle'} onClick={() => printFrom(`/api/slips/${batch.id}`)}>Reprint</button>}
          </div>
        </div>
        {batch.failed.length > 0 && <p className="mt-2 text-[13px] text-amber">Not marked In progress in Shopify: {batch.failed.map(item => `${item.name} (${item.error})`).join('; ')}</p>}
        {messages[batch.id] && <p role="status" className="mt-2 text-[13px]">{messages[batch.id]}</p>}
      </div>)}</div>
    </div>
  </section>
}
