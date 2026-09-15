'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CodePlan } from '@/lib/labels/prepare-codes'

export function PrepareCodes({ productId, title }: { productId: string; title: string }) {
  const [plan, setPlan] = useState<CodePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const router = useRouter()
  async function run(action: 'preview' | 'apply') {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/labels/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, productId, fingerprint: plan?.fingerprint }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Could not prepare codes.')
      if (action === 'preview') setPlan(result.plan)
      else { setDone(true); setPlan(null); router.refresh() }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach Loupe. Retry.') }
    finally { setBusy(false) }
  }
  return <div className="mb-4 rounded-card bg-surface p-5 text-[13px]">
    <div className="flex flex-wrap items-center justify-between gap-3"><p>{title} <span className="text-ink-soft">· Existing product codes</span></p><button type="button" disabled={busy} onClick={() => run('preview')} className="rounded-pill bg-chip px-4 py-2 disabled:opacity-40">{busy ? 'Checking…' : 'Prepare codes'}</button></div>
    {error && <p role="alert" className="mt-3 text-amber">{error}</p>}
    {done && <p role="status" className="mt-3">Codes saved. Choose label copies below. Shopify search may need a moment to catch up.</p>}
    {plan && <div className="mt-4">
      <p className="text-ink-soft">Review each option before saving. Replace old stickers on this product when the new labels are printed. Existing distinct barcodes are preserved.</p>
      <div className="my-3 overflow-x-auto"><table className="w-full text-left text-[12px]"><thead><tr><th className="py-2">Option</th><th>SKU before → after</th><th>Barcode</th></tr></thead><tbody>{plan.rows.map(row => <tr key={row.id} className="border-t border-chip"><td className="py-3 pr-3">{row.title}</td><td className="pr-3 font-mono">{row.oldSku} → {row.sku}</td><td className="font-mono">{row.barcode}</td></tr>)}</tbody></table></div>
      <button type="button" disabled={busy} onClick={() => run('apply')} className="rounded-pill bg-ink px-5 py-2.5 text-white disabled:opacity-40">Save these codes to Shopify</button>
      <button type="button" disabled={busy} onClick={() => setPlan(null)} className="ml-3 px-4 py-2">Close</button>
    </div>}
  </div>
}
