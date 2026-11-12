'use server'

import { revalidatePath } from 'next/cache'
import { requireOperatorForAction } from '@/lib/auth/authorize'
import { listShortages, resolveShortage } from '@/lib/qc/shortages'
import { notifyMissing } from '@/lib/qc/bot'

export interface ResolveState { readonly ok: boolean; readonly message: string; readonly ref?: number }

/** Form action: an operator resolves one shortage. Resolver identity comes from the session, never the form. */
export async function resolveShortageAction(_previous: ResolveState | null, form: FormData): Promise<ResolveState> {
  try {
    const operator = await requireOperatorForAction()
    const { shortage, changed } = await resolveShortage({ ref: form.get('ref'), resolution: form.get('resolution'), note: form.get('note') ?? '', by: operator.name || operator.email })
    revalidatePath('/qc/shortages')
    return { ok: true, ref: shortage.ref, message: changed ? `#${shortage.ref} resolved · ${shortage.resolution}.` : `#${shortage.ref} was already resolved · ${shortage.resolution} by ${shortage.resolved_by}.` }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : 'Could not resolve the shortage.' }
  }
}

/** Form action: send one order's open shortages to the WhatsApp bot again (D168), for when the send at Confirm QC failed. */
export async function sendMissingAction(_previous: ResolveState | null, form: FormData): Promise<ResolveState> {
  try {
    const operator = await requireOperatorForAction()
    const orderId = String(form.get('orderId') ?? '')
    const open = (await listShortages(1)).open.filter(item => item.order_id === orderId)
    if (!open.length) return { ok: false, message: 'This order has no open shortage.' }
    const notice = await notifyMissing(open[0].order_name, open, operator.name || operator.email)
    return notice ? { ok: !notice.includes('did not take'), message: notice } : { ok: false, message: 'The WhatsApp bot is not connected to Loupe yet.' }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : 'Could not send to WhatsApp.' }
  }
}
