'use client'

import { useMemo, useState, useTransition } from 'react'

import type { CuratedModel } from '@/lib/prompts/models'

/**
 * D121 — the /models section body: the enhancement pipeline as a vertical
 * flow, one card per stage. The two human steps render as quiet chips; the
 * four model stages carry a dropdown of their curated choices and save
 * through one server action. "Black means active": the currently effective
 * model is the bold line of each card.
 */

export interface StageView {
  readonly key: string
  readonly label: string
  readonly description: string
  readonly appliesNote: string
  readonly model: string
  readonly isDefault: boolean
  readonly updatedBy: string | null
  readonly options: readonly CuratedModel[]
}

export function PipelineDiagram({
  stages,
  action,
}: {
  readonly stages: readonly StageView[]
  readonly action: (formData: FormData) => Promise<void>
}) {
  return (
    <ol className="flex max-w-[640px] flex-col">
      <HumanStep
        first
        title="Upload & category"
        detail="You drop the photo and tap its category — nothing guesses that."
      />
      {stages.map((stage) => (
        <ModelStep key={stage.key} stage={stage} action={action} />
      ))}
      <HumanStep
        last
        title="Approve"
        detail="You review the finished render in the console. Failed check verdicts arrive flagged."
      />
    </ol>
  )
}

function Connector() {
  return (
    <div className="ml-[27px] h-6 w-px bg-[color:var(--ink)]/15" aria-hidden="true" />
  )
}

function HumanStep({
  title,
  detail,
  first = false,
  last = false,
}: {
  title: string
  detail: string
  first?: boolean
  last?: boolean
}) {
  return (
    <li className="flex flex-col">
      {first ? null : <Connector />}
      <div className="flex items-center gap-3.5 rounded-card bg-chip px-5 py-3.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-white">
          {first ? '⇥' : '✓'}
        </span>
        <div>
          <div className="text-[13px] font-medium">{title} · you</div>
          <div className="text-[11.5px] text-muted-foreground">{detail}</div>
        </div>
      </div>
      {last ? null : null}
    </li>
  )
}

function ModelStep({
  stage,
  action,
}: {
  readonly stage: StageView
  readonly action: (formData: FormData) => Promise<void>
}) {
  const [selected, setSelected] = useState(stage.model)
  const [pending, startTransition] = useTransition()
  const chosen = useMemo(
    () => stage.options.find((option) => option.id === selected) ?? null,
    [stage.options, selected],
  )
  const dirty = selected !== stage.model

  return (
    <li className="flex flex-col">
      <Connector />
      <div className="rounded-card bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{stage.label}</h2>
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
            {chosen?.tier ?? ''}
          </span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
          {stage.description}
        </p>

        <form
          action={(formData) => startTransition(() => action(formData))}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="stage" value={stage.key} />
          <select
            name="model"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            aria-label={`Model for ${stage.label}`}
            className="min-w-0 flex-1 rounded-pill bg-chip px-3.5 py-2 text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
          >
            {stage.options.map((option) => (
              <option key={option.id} value={option.id} title={option.note}>
                {option.label} · {option.priceHint}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={!dirty || pending}
            className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white transition-opacity disabled:opacity-30"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </form>

        {chosen ? (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{chosen.note}</p>
        ) : null}
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">
          {stage.appliesNote}
          {stage.isDefault
            ? ' · using the researched default'
            : stage.updatedBy
              ? ` · set by ${stage.updatedBy}`
              : ''}
        </p>
      </div>
    </li>
  )
}
