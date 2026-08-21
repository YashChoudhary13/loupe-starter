'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import { nudgeEnhanceCron } from '@/lib/cron/jobs'
import { newSkuFromRestock, reopenIdentification, restockExisting, type RestockQuantity } from '@/lib/match/restock-actions'
import { loadRestockQueue, type RestockSnapshot } from '@/lib/match/restock-read-model'

export type RestockActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly detail: string | null; readonly retryable: boolean }

async function withOperator<T>(run: (operator: Awaited<ReturnType<typeof requireOperatorForAction>>) => Promise<T>): Promise<RestockActionResult<T>> {
  try {
    return { ok: true, data: await run(await requireOperatorForAction()) }
  } catch (cause) {
    if (cause instanceof NotAuthorisedError) return { ok: false, error: cause.message, detail: null, retryable: false }
    if (cause instanceof ConsoleError) return { ok: false, error: cause.operatorMessage, detail: cause.detail, retryable: cause.retryable }
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.error('restock action failed:', detail)
    return { ok: false, error: 'That did not work. Reload Restock and try again.', detail, retryable: true }
  }
}

export async function refreshRestockAction(): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(() => loadRestockQueue())
}

export async function restockExistingAction(input: {
  readonly intakeFileId: string
  readonly productId: string
  readonly quantities: readonly RestockQuantity[]
}): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(async (operator) => {
    await restockExisting(operator, input)
    return loadRestockQueue()
  })
}

export async function newSkuFromRestockAction(input: {
  readonly intakeFileId: string
  readonly productId: string | null
  readonly wantsNewImage: boolean
  readonly categorySlug: string | null
  readonly settingSlug: string | null
}): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(async (operator) => {
    await newSkuFromRestock(operator, input)
    if (input.wantsNewImage) await nudgeEnhanceCron()
    return loadRestockQueue()
  })
}

export async function reopenIdentificationAction(input: { readonly intakeFileId: string }): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(async (operator) => {
    await reopenIdentification(operator, input.intakeFileId)
    return loadRestockQueue()
  })
}
