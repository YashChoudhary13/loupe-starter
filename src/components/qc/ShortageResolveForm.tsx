'use client'

import { useActionState } from 'react'
import { resolveShortageAction, type ResolveState } from '@/app/(shell)/qc/shortages/actions'
import { QC_STAFF_RESOLUTIONS } from '@/lib/qc/types'

const LABELS: Record<string, string> = { refund: 'Refunded', coupon: 'Coupon sent', shipped: 'Shipped later', other: 'Other' }

export function ShortageResolveForm({ shortageRef }: { shortageRef: number }) {
  const [state, action, pending] = useActionState<ResolveState | null, FormData>(resolveShortageAction, null)
  if (state?.ok) return <p role="status" className="text-[13px] font-medium">✓ {state.message}</p>
  return <form action={action} className="flex flex-wrap items-center gap-2">
    <input type="hidden" name="ref" value={shortageRef} />
    <select name="resolution" required defaultValue="" className="rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink">
      <option value="" disabled>How was it settled?</option>
      {QC_STAFF_RESOLUTIONS.map(value => <option key={value} value={value}>{LABELS[value] ?? value}</option>)}
    </select>
    <input name="note" maxLength={240} placeholder="Note, for example coupon code or refund ref" className="min-w-0 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink" />
    <button disabled={pending} className="rounded-pill bg-ink px-5 py-2 text-[13px] text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40">{pending ? 'Saving…' : 'Mark resolved'}</button>
    {state && !state.ok && <p role="alert" className="w-full text-[12px] text-amber">{state.message}</p>}
  </form>
}
