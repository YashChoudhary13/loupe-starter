'use client'

import { useActionState, useState } from 'react'

import {
  createPromptVersionAction,
  type PromptVersionFormState,
} from '@/app/prompts/actions'
import type { PromptKind } from '@/lib/prompts/library'

interface ModelOption {
  readonly id: string
  readonly label: string
  readonly tier: string
}

const INITIAL_STATE: PromptVersionFormState = { status: 'idle', message: null }

export function PromptVersionForm({
  kind,
  currentName,
  currentBody,
  currentModel,
  models,
}: {
  kind: PromptKind
  currentName: string
  currentBody: string
  currentModel: string
  models: readonly ModelOption[]
}) {
  const [state, formAction, pending] = useActionState(
    createPromptVersionAction,
    INITIAL_STATE,
  )
  const [name, setName] = useState(currentName)
  const [body, setBody] = useState(currentBody)
  const [model, setModel] = useState(currentModel)

  return (
    <form action={formAction} className="mt-4">
      <input type="hidden" name="kind" value={kind} />
      <label
        htmlFor={`${kind}-version-name`}
        className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground"
      >
        Version name
      </label>
      <input
        id={`${kind}-version-name`}
        name="name"
        required
        maxLength={160}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="mt-1.5 w-full rounded-field bg-chip px-3 py-2.5 text-[12px] text-ink outline-none focus:ring-2 focus:ring-ink/15"
      />
      <label
        htmlFor={`${kind}-version-body`}
        className="mt-3 block text-[9px] uppercase tracking-[0.12em] text-muted-foreground"
      >
        Prompt
      </label>
      <textarea
        id={`${kind}-version-body`}
        name="body"
        required
        maxLength={20_000}
        rows={12}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="mt-1.5 w-full resize-y rounded-field bg-chip px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-ink outline-none focus:ring-2 focus:ring-ink/15"
      />
      <label
        htmlFor={`${kind}-version-model`}
        className="mt-3 block text-[9px] uppercase tracking-[0.12em] text-muted-foreground"
      >
        Model
      </label>
      <select
        id={`${kind}-version-model`}
        name="model"
        value={model}
        onChange={(event) => setModel(event.target.value)}
        className="mt-1.5 w-full rounded-field bg-chip px-3 py-2.5 text-[11.5px] text-ink outline-none focus:ring-2 focus:ring-ink/15"
      >
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.tier} · {option.label}
          </option>
        ))}
      </select>
      {kind === 'image' ? (
        <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
          Loupe keeps one PRODUCT block for the generated product description. If a pasted
          prompt has none, Loupe adds it. Keep the {'{{COMPOSITION_DETAIL}}'} token if the
          describer should choose the pose, or remove it if this prompt stages the product
          itself.
        </p>
      ) : null}
      {state.message ? (
        <p
          role={state.status === 'error' ? 'alert' : 'status'}
          className={`mt-3 rounded-field px-3 py-2.5 text-[10.5px] leading-relaxed ${
            state.status === 'error'
              ? 'bg-[#fff7e8] text-amber'
              : 'bg-chip text-ink-soft'
          }`}
        >
          {state.message}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-pill bg-ink px-4 py-2 text-[11px] font-medium text-white transition-colors hover:bg-[#242428] disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save new version'}
      </button>
    </form>
  )
}
