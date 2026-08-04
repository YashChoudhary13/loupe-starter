'use server'

import { requireOperatorForAction } from '@/lib/auth/authorize'
import { loadLiveActivity } from '@/lib/live/activity'
import type { LiveActivitySnapshot } from '@/lib/live/types'

export type LiveActivityActionResult =
  | { readonly ok: true; readonly data: LiveActivitySnapshot }
  | { readonly ok: false }

export async function liveActivityAction(
  afterEventId: number | null,
): Promise<LiveActivityActionResult> {
  try {
    await requireOperatorForAction()
    const cursor =
      afterEventId === null ||
      (Number.isSafeInteger(afterEventId) && afterEventId >= 0)
        ? afterEventId
        : null
    return { ok: true, data: await loadLiveActivity(cursor) }
  } catch (cause) {
    console.error(
      'live activity failed:',
      cause instanceof Error ? cause.message : String(cause),
    )
    return { ok: false }
  }
}
