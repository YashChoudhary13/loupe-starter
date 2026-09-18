'use server'

import { revalidatePath } from 'next/cache'
import { requireOperatorForAction } from '@/lib/auth/authorize'
import { resolveShortage } from '@/lib/qc/shortages'

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
