'use server'

import { decideRestockCandidate, deleteRestockCandidates, loadRestockCandidates, type RestockCandidateItem, type RestockDecision } from '@/lib/agent-intake/restock'
import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import { deleteRestockDecision, newSkuFromRestock, reopenIdentification, restockExisting, saveReferenceOnly, type RestockQuantity } from '@/lib/match/restock-actions'
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
}): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(async (operator) => {
    await newSkuFromRestock(operator, input)
    return loadRestockQueue()
  })
}

export async function saveReferenceOnlyAction(input: {
  readonly intakeFileId: string
  readonly decisionId: string
  readonly sku: string | null
}): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(async (operator) => {
    await saveReferenceOnly(operator, input)
    return loadRestockQueue()
  })
}

export async function reopenIdentificationAction(input: { readonly intakeFileId: string }): Promise<RestockActionResult<RestockSnapshot>> {
  return withOperator(async (operator) => {
    await reopenIdentification(operator, input.intakeFileId)
    return loadRestockQueue()
  })
}

/** D148: the candidates Claude posted, still waiting for a choice. */
export async function refreshRestockCandidatesAction(): Promise<RestockActionResult<readonly RestockCandidateItem[]>> {
  return withOperator(() => loadRestockCandidates())
}

/** D148: use the old image, generate a new one, or wrong restock. The list comes back without the photograph. */
export async function decideRestockCandidateAction(input: {
  readonly photoId: string
  readonly choice: RestockDecision
  readonly sku: string | null
}): Promise<RestockActionResult<readonly RestockCandidateItem[]>> {
  return withOperator(async (operator) => {
    if (input.choice !== 'use_old' && input.choice !== 'generate' && input.choice !== 'wrong') throw new ConsoleError('Unknown choice.', null, false)
    await decideRestockCandidate(operator, { photoId: String(input.photoId), choice: input.choice, sku: typeof input.sku === 'string' ? input.sku : null })
    return loadRestockCandidates()
  })
}

/** D154: Delete on one card, or Clear all. Nothing is sent anywhere; both lists come back fresh. */
export async function deleteRestockAction(input: {
  readonly photoIds: readonly string[]
  readonly intakeFileIds: readonly string[]
}): Promise<RestockActionResult<{ readonly candidates: readonly RestockCandidateItem[]; readonly snapshot: RestockSnapshot; readonly deleted: number }>> {
  return withOperator(async (operator) => {
    const ids = (raw: unknown) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string').slice(0, 500) : [])
    let deleted = await deleteRestockCandidates(operator, ids(input.photoIds))
    for (const intakeFileId of ids(input.intakeFileIds)) {
      await deleteRestockDecision(operator, intakeFileId)
      deleted += 1
    }
    const [candidates, snapshot] = await Promise.all([loadRestockCandidates(), loadRestockQueue()])
    return { candidates, snapshot, deleted }
  })
}
