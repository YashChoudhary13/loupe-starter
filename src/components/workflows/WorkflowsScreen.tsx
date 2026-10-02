'use client'

import { useEffect, useRef, useState } from 'react'

import { listWorkflowRunsAction, startWorkflowAction } from '@/app/(shell)/workflows/actions'
import { cn } from '@/lib/utils'
import {
  WORKFLOWS,
  type DateRangeInput,
  type StepState,
  type StepStatus,
  type WorkflowDefinition,
  type WorkflowRunView,
} from '@/lib/workflows/types'

const POLL_MS = 2_000

/**
 * D122 — one card per workflow. The timeline is the run row's own steps, so
 * every browser shows the same progress; polling runs only while something is
 * running. Colours follow DESIGN.md: black means running, green ticks for
 * finished timeline steps, amber for anything a human should read.
 */
export function WorkflowsScreen({ initialRuns }: { initialRuns: readonly WorkflowRunView[] }) {
  const [runs, setRuns] = useState(initialRuns)
  const [starting, setStarting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const inFlight = useRef(false)

  const anyRunning = runs.some((run) => run.status === 'running')

  useEffect(() => {
    if (!anyRunning) return
    let stopped = false
    const poll = async () => {
      if (stopped || inFlight.current || document.visibilityState === 'hidden') return
      inFlight.current = true
      try {
        const result = await listWorkflowRunsAction()
        if (!stopped && result.ok) setRuns(result.data)
      } finally {
        inFlight.current = false
      }
    }
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void poll()
    }, POLL_MS)
    const tick = window.setInterval(() => setNow(Date.now()), 1_000)
    window.addEventListener('focus', poll)
    return () => {
      stopped = true
      window.clearInterval(timer)
      window.clearInterval(tick)
      window.removeEventListener('focus', poll)
    }
  }, [anyRunning])

  const start = async (key: string, dates?: DateRangeInput) => {
    setStarting(key)
    setError(null)
    const result = await startWorkflowAction(key, dates)
    setStarting(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const run = result.data.run
    setRuns((current) => [run, ...current.filter((existing) => existing.id !== run.id)])
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      {error ? (
        <div role="alert" className="rounded-panel bg-surface px-4 py-3 text-[12px] text-amber">
          {error}
        </div>
      ) : null}
      {WORKFLOWS.map((definition) => (
        <WorkflowCard
          key={definition.key}
          definition={definition}
          runs={runs.filter((run) => run.workflow === definition.key)}
          now={now}
          starting={starting === definition.key}
          onRun={(dates) => void start(definition.key, dates)}
        />
      ))}
    </div>
  )
}

function WorkflowCard({
  definition,
  runs,
  now,
  starting,
  onRun,
}: {
  definition: WorkflowDefinition
  runs: readonly WorkflowRunView[]
  now: number
  starting: boolean
  onRun: (dates?: DateRangeInput) => void
}) {
  const latest = runs[0] ?? null
  const running = latest?.status === 'running'
  const [dates, setDates] = useState(defaultRange)
  const days = Math.round((Date.parse(dates.to) - Date.parse(dates.from)) / 86_400_000) + 1
  const rangeProblem = !definition.dateRange
    ? null
    : !dates.from || !dates.to || Number.isNaN(days)
      ? 'Pick both dates.'
      : days < 1
        ? 'From must be on or before To.'
        : days > 92
          ? 'At most 92 days at a time.'
          : null
  const steps: readonly StepState[] =
    latest?.steps ??
    definition.steps.map((step) => ({
      ...step,
      status: 'pending' as const,
      detail: null,
      startedAt: null,
      finishedAt: null,
    }))

  return (
    <section className="rounded-card bg-surface p-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{definition.title}</h2>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{definition.description}</p>
          <p className="mt-1.5 text-[10.5px] text-muted-foreground">
            <span className="uppercase tracking-[0.1em]">Writes</span> · {definition.writes}
          </p>
          {definition.dateRange ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <DateField label="From" value={dates.from} max={dates.to || istDay(0)} onChange={(from) => setDates((current) => ({ ...current, from }))} />
              <DateField label="To" value={dates.to} min={dates.from} max={istDay(0)} onChange={(to) => setDates((current) => ({ ...current, to }))} />
              <span className={cn('pb-2 text-[11.5px] tabular-nums', rangeProblem ? 'text-amber' : 'text-muted-foreground')}>
                {rangeProblem ?? `${days} day${days === 1 ? '' : 's'}, both dates included`}
              </span>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onRun(definition.dateRange ? dates : undefined)}
          disabled={running || starting || rangeProblem !== null}
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-pill px-4 py-2 text-[12px] font-medium text-white transition-opacity',
            'bg-ink disabled:opacity-40',
          )}
        >
          {running ? (
            <>
              <span className="size-1.5 rounded-full bg-white/85 motion-safe:animate-pulse" aria-hidden />
              Running · {elapsed(latest!.startedAt, now)}
            </>
          ) : starting ? (
            'Starting…'
          ) : definition.dateRange ? (
            'Send'
          ) : (
            'Run'
          )}
        </button>
      </div>

      <ol className="mt-4 flex flex-col">
        {steps.map((step, index) => (
          <StepRow key={step.key} step={step} first={index === 0} now={now} />
        ))}
      </ol>

      {latest ? <RunOutcome run={latest} /> : null}
      {runs.length > 1 ? <PreviousRuns runs={runs.slice(1)} /> : null}
    </section>
  )
}

function StepRow({ step, first, now }: { step: StepState; first: boolean; now: number }) {
  const active = step.status === 'running'
  return (
    <li className="flex flex-col">
      {first ? null : <div className="ml-[13px] h-4 w-px bg-[color:var(--ink)]/15" aria-hidden />}
      <div className="flex items-start gap-3">
        <StepDot status={step.status} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div
            className={cn(
              'text-[12.5px] transition-colors duration-300',
              step.status === 'pending' || step.status === 'skipped' ? 'text-muted-foreground' : 'text-ink',
              active && 'font-medium',
            )}
          >
            {step.label}
            {step.status === 'skipped' ? <span className="ml-2 text-[10.5px] uppercase tracking-[0.1em]">skipped</span> : null}
          </div>
          {step.detail || active ? (
            <div
              className={cn(
                'mt-0.5 text-[11.5px] leading-snug transition-colors duration-300',
                step.status === 'failed' || step.status === 'warning' ? 'text-amber' : 'text-muted-foreground',
              )}
            >
              {step.detail ?? 'Working…'}
              {active && step.startedAt ? <span className="ml-2 tabular-nums opacity-70">{elapsed(step.startedAt, now)}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function StepDot({ status }: { status: StepStatus }) {
  const base = 'grid size-[26px] shrink-0 place-items-center rounded-full text-[12px] font-semibold transition-all duration-300'
  switch (status) {
    case 'running':
      return (
        <span className={cn(base, 'bg-ink')} aria-label="running">
          <span className="size-2 rounded-full bg-white motion-safe:animate-pulse" aria-hidden />
        </span>
      )
    case 'done':
      return <span className={cn(base, 'bg-green text-white')} aria-label="done">✓</span>
    case 'warning':
      return <span className={cn(base, 'bg-amber text-white')} aria-label="finished with a warning">!</span>
    case 'failed':
      return <span className={cn(base, 'bg-amber text-white')} aria-label="failed">×</span>
    case 'skipped':
      return <span className={cn(base, 'border border-dashed border-[color:var(--ink)]/25')} aria-label="skipped" />
    default:
      return <span className={cn(base, 'bg-chip')} aria-label="not started" />
  }
}

function RunOutcome({ run }: { run: WorkflowRunView }) {
  const hasDetails = run.sections.length > 0 || run.log.length > 0
  return (
    <div className="mt-4 border-t border-[color:var(--ink)]/10 pt-3 text-[11.5px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-muted-foreground">
          {run.status === 'running' ? 'Started' : run.status === 'succeeded' ? 'Finished' : 'Failed'}{' '}
          {when(run.finishedAt ?? run.startedAt)} · {run.startedBy.split('@')[0]}
        </span>
        {run.summary ? <span className="text-ink">{run.summary}</span> : null}
        {run.error ? <span className="text-amber">{run.error}</span> : null}
      </div>
      {hasDetails ? (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-muted-foreground">Details</summary>
          <div className="mt-2 flex flex-col gap-3">
            {run.sections.map((section, index) => (
              <div key={`${section.title}:${index}`}>
                <div className="text-[10.5px] uppercase tracking-[0.11em] text-muted-foreground">{section.title}</div>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {section.rows.map((row, rowIndex) => (
                    <li key={rowIndex} className="break-words text-ink-soft">{row}</li>
                  ))}
                </ul>
              </div>
            ))}
            {run.log.length > 0 ? (
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.11em] text-muted-foreground">Log</div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-ink-soft">
                  {run.log.join('\n')}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function PreviousRuns({ runs }: { runs: readonly WorkflowRunView[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      {runs.map((run) => (
        <li key={run.id}>
          {when(run.finishedAt ?? run.startedAt)} · {run.startedBy.split('@')[0]} ·{' '}
          {run.status === 'failed' ? (run.error ?? 'failed') : (run.summary ?? run.status)}
        </li>
      ))}
    </ul>
  )
}

function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: string
  min?: string
  max?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
      {label}
      <input
        type="date"
        required
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-pill bg-chip px-4 py-2 text-[12.5px] normal-case tracking-normal text-ink tabular-nums focus:outline-2 focus:outline-ink"
      />
    </label>
  )
}

/** YYYY-MM-DD in India, `offset` days from today. */
function istDay(offset: number): string {
  return new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10)
}

/** Yesterday and the first of its month: the 1st of a month offers the whole previous month. */
function defaultRange(): DateRangeInput {
  const to = istDay(-1)
  return { from: `${to.slice(0, 8)}01`, to }
}

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  })
}
