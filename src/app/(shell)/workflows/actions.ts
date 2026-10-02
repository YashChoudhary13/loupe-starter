'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { financeRange } from '@/lib/home/actions'
import { listWorkflowRuns, startWorkflow } from '@/lib/workflows/runner'
import { WORKFLOWS, type DateRangeInput, type WorkflowKey, type WorkflowRunView } from '@/lib/workflows/types'

export type WorkflowActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string }

async function withOperator<T>(run: (email: string) => Promise<T>): Promise<WorkflowActionResult<T>> {
  try {
    const operator = await requireOperatorForAction()
    return { ok: true, data: await run(operator.email) }
  } catch (cause) {
    if (cause instanceof NotAuthorisedError) return { ok: false, error: cause.message }
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.error('workflow action failed:', detail)
    return { ok: false, error: detail }
  }
}

export async function startWorkflowAction(
  key: string,
  dates?: DateRangeInput,
): Promise<WorkflowActionResult<{ run: WorkflowRunView; started: boolean }>> {
  return withOperator(async (email) => {
    // The key arrives from a browser; only the catalogue decides what exists.
    const definition = WORKFLOWS.find((workflow) => workflow.key === key)
    if (!definition) throw new Error('That workflow does not exist.')
    let input: DateRangeInput | null = null
    if (definition.dateRange) {
      const checked = financeRange({ from: dates?.from, to: dates?.to }, new Date())
      if (!checked.ok) throw new Error(checked.error)
      input = { from: checked.params.from, to: checked.params.to }
    }
    return startWorkflow(definition.key as WorkflowKey, email, undefined, input)
  })
}

export async function listWorkflowRunsAction(): Promise<WorkflowActionResult<readonly WorkflowRunView[]>> {
  return withOperator(() => listWorkflowRuns())
}
