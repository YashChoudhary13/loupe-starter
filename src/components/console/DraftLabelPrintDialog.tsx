'use client'

import { useState } from 'react'
import type { DraftLabelOffer } from '@/lib/labels/draft-print'

const field = 'rounded-pill bg-chip px-4 py-2.5 text-[13px] text-ink focus:outline-2 focus:outline-ink'
const button = 'rounded-pill px-5 py-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40'

export function DraftLabelPrintDialog({
  offer,
  busy,
  error,
  onCancel,
  onPrint,
}: {
  offer: DraftLabelOffer
  busy: boolean
  error: string | null
  onCancel: () => void
  onPrint: (copies: Record<string, number>) => void
}) {
  const [copies, setCopies] = useState(() => Object.fromEntries(offer.items.map(item => [item.id, item.copies])))
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="draft-label-title">
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-card bg-white p-5 shadow-sm">
        <h2 id="draft-label-title" className="text-[18px] font-medium">Print labels for {offer.sku}</h2>
        <p className="mt-2 text-[13px] text-ink-soft">Copies start at the quantity you saved. Cancel leaves this draft as label not printed.</p>
        <ul className="mt-4 grid gap-3">
          {offer.items.map(item => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-chip p-4">
              <div className="min-w-0">
                <p className="text-[14px] font-medium">{item.title}</p>
                <p className="mt-1 break-all font-mono text-[12px]">{item.barcode || item.sku || 'Barcode missing'}</p>
              </div>
              <label className="grid gap-1 text-[12px]">
                Copies
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={copies[item.id] ?? 0}
                  disabled={busy || !item.barcode}
                  onChange={event => setCopies(current => ({ ...current, [item.id]: Number(event.target.value) }))}
                  className={`${field} w-24`}
                />
              </label>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="mt-3 text-[13px] text-amber">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => onPrint(copies)} className={`${button} bg-ink text-white`}>{busy ? 'Preparing…' : 'Print'}</button>
          <button type="button" disabled={busy} onClick={onCancel} className={`${button} bg-chip`}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
