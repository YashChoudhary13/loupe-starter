import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { after } from 'next/server'

import { supabaseServer } from '@/lib/supabase/server'

import {
  workflowDefinition,
  type ResultSection,
  type StepState,
  type WorkflowKey,
  type WorkflowRunView,
} from './types'

/**
 * D122 — runs one workflow as a durable, observable sequence of steps.
 *
 * `startWorkflow` inserts the run row and returns at once; the steps execute
 * in `after()` inside this same Node process (the pattern the console already
 * uses for background Shopify pushes) and write their progress back onto the
 * row. Browsers poll `listWorkflowRuns` while anything is running.
 *
 * A step that throws fails the run and skips the rest. A step that wants the
 * run to continue past a problem returns `{ detail, warning: true }` — the
 * card shows it amber, the run still finishes.
 */

/** A "running" row silent for this long belongs to a process that is gone. */
const STALE_AFTER_MS = 15 * 60_000
/** Progress lines are written at most this often; status changes always flush. */
const REPORT_INTERVAL_MS = 400
const RUNS_PER_WORKFLOW = 4

export type StepOutcome = string | { readonly detail: string; readonly warning?: boolean }

export interface StepContext {
  readonly actor: string
  /** Replace the step's live line ("page 12/36"). */
  report(detail: string): Promise<void>
  /** Append a line to the run's log. */
  log(line: string): void
  /** Add a titled list to the run's Details. */
  section(title: string, rows: readonly string[]): void
  /** Set the one-line summary shown under the timeline when the run ends. */
  summary(text: string): void
}

export interface WorkflowStep {
  readonly key: string
  readonly label: string
  run(context: StepContext): Promise<StepOutcome>
}

export interface WorkflowProgram {
  readonly steps: readonly WorkflowStep[]
}

interface RunRow {
  id: string
  workflow: WorkflowKey
  status: 'running' | 'succeeded' | 'failed'
  started_by: string
  started_at: string
  finished_at: string | null
  steps: StepState[]
  summary: string | null
  error: string | null
  log: string[]
  result: { sections?: ResultSection[] }
}

const RUN_COLUMNS =
  'id, workflow, status, started_by, started_at, finished_at, steps, summary, error, log, result'

function view(row: RunRow): WorkflowRunView {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    steps: row.steps ?? [],
    summary: row.summary,
    error: row.error,
    log: row.log ?? [],
    sections: row.result?.sections ?? [],
  }
}

async function loadProgram(key: WorkflowKey): Promise<WorkflowProgram> {
  switch (key) {
    case 'material':
      return (await import('./material')).materialProgram()
    case 'reconciliation':
      return (await import('./reconciliation')).reconciliationProgram()
    case 'copy_rules':
      return (await import('./copy-rules')).copyRulesProgram()
    case 'collections':
      return (await import('./collections')).collectionsProgram()
  }
}

async function failStaleRuns(db: SupabaseClient): Promise<void> {
  const { error } = await db
    .from('workflow_runs')
    .update({
      status: 'failed',
      error: 'Loupe restarted during this run. Press Run again.',
      finished_at: new Date().toISOString(),
    })
    .eq('status', 'running')
    .lt('updated_at', new Date(Date.now() - STALE_AFTER_MS).toISOString())
  if (error) throw new Error(`Could not clear stale workflow runs: ${error.message}`)
}

export async function listWorkflowRuns(
  db: SupabaseClient = supabaseServer(),
): Promise<readonly WorkflowRunView[]> {
  await failStaleRuns(db)
  const { data, error } = await db
    .from('workflow_runs')
    .select(RUN_COLUMNS)
    .order('started_at', { ascending: false })
    .limit(60)
  if (error) throw new Error(`Could not load workflow runs: ${error.message}`)

  const perWorkflow = new Map<string, number>()
  return ((data ?? []) as RunRow[])
    .filter((row) => {
      const seen = perWorkflow.get(row.workflow) ?? 0
      perWorkflow.set(row.workflow, seen + 1)
      return seen < RUNS_PER_WORKFLOW
    })
    .map(view)
}

export interface StartResult {
  readonly run: WorkflowRunView
  /** False when a run was already in flight and this press joined it. */
  readonly started: boolean
}

export async function startWorkflow(
  key: WorkflowKey,
  actor: string,
  db: SupabaseClient = supabaseServer(),
): Promise<StartResult> {
  const definition = workflowDefinition(key)
  await failStaleRuns(db)

  const steps: StepState[] = definition.steps.map((step) => ({
    key: step.key,
    label: step.label,
    status: 'pending',
    detail: null,
    startedAt: null,
    finishedAt: null,
  }))
  const { data, error } = await db
    .from('workflow_runs')
    .insert({ workflow: key, started_by: actor, steps })
    .select(RUN_COLUMNS)
    .single<RunRow>()

  if (error?.code === '23505') {
    const { data: active, error: activeError } = await db
      .from('workflow_runs')
      .select(RUN_COLUMNS)
      .eq('workflow', key)
      .eq('status', 'running')
      .maybeSingle<RunRow>()
    if (activeError || !active) {
      throw new Error(activeError?.message ?? 'A run was already in flight but could not be read.')
    }
    return { run: view(active), started: false }
  }
  if (error || !data) throw new Error(`Could not start ${definition.title}: ${error?.message}`)

  const runId = data.id
  after(async () => {
    await execute(runId, key, actor, steps, db).catch(() => undefined)
  })
  return { run: view(data), started: true }
}

async function execute(
  runId: string,
  key: WorkflowKey,
  actor: string,
  steps: StepState[],
  db: SupabaseClient,
): Promise<void> {
  const log: string[] = []
  const sections: ResultSection[] = []
  let summary: string | null = null
  let lastFlush = 0

  const patch = (index: number, change: Partial<StepState>) => {
    steps[index] = { ...steps[index], ...change }
  }
  const flush = async (force: boolean) => {
    const now = Date.now()
    if (!force && now - lastFlush < REPORT_INTERVAL_MS) return
    lastFlush = now
    await db
      .from('workflow_runs')
      .update({ steps, log, updated_at: new Date().toISOString() })
      .eq('id', runId)
  }
  const stamp = () => new Date().toISOString()

  let program: WorkflowProgram
  let failure: string | null = null
  try {
    program = await loadProgram(key)
  } catch (cause) {
    program = { steps: [] }
    failure = cause instanceof Error ? cause.message : String(cause)
  }

  for (const [index, step] of program.steps.entries()) {
    if (failure !== null) {
      patch(index, { status: 'skipped' })
      continue
    }
    patch(index, { status: 'running', startedAt: stamp(), detail: null })
    await flush(true)

    const context: StepContext = {
      actor,
      report: async (detail) => {
        patch(index, { detail })
        await flush(false)
      },
      log: (line) => {
        log.push(line)
      },
      section: (title, rows) => {
        sections.push({ title, rows: [...rows] })
      },
      summary: (text) => {
        summary = text
      },
    }

    try {
      const outcome = await step.run(context)
      const detail = typeof outcome === 'string' ? outcome : outcome.detail
      const warning = typeof outcome === 'string' ? false : outcome.warning === true
      patch(index, { status: warning ? 'warning' : 'done', detail, finishedAt: stamp() })
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause)
      patch(index, { status: 'failed', detail: failure.slice(0, 500), finishedAt: stamp() })
      log.push(`${step.label}: ${failure}`)
    }
    await flush(true)
  }

  const warnings = steps.filter((step) => step.status === 'warning').length
  const finalSummary =
    summary ??
    (failure !== null
      ? null
      : warnings > 0
        ? `Finished with ${warnings} warning${warnings === 1 ? '' : 's'}.`
        : 'Finished.')

  await db
    .from('workflow_runs')
    .update({
      status: failure === null ? 'succeeded' : 'failed',
      error: failure === null ? null : failure.slice(0, 2_000),
      summary: finalSummary,
      steps,
      log,
      result: { sections },
      finished_at: stamp(),
      updated_at: stamp(),
    })
    .eq('id', runId)

  await db.from('events').insert({
    entity_type: 'workflow',
    entity_id: runId,
    event: failure === null ? 'workflow.finished' : 'workflow.failed',
    detail: { workflow: key, summary: finalSummary, error: failure, warnings },
    actor,
  })
}
