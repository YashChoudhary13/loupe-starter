'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Review — and optionally edit — the prompt before a redo is paid for.
 *
 * A redo is a real charge against a real budget (~$0.07 an image), and until now
 * pressing "Redo image" spent it immediately on a prompt the operator could not
 * see. This puts the exact resolved text in front of them first.
 *
 * An edit here applies to THIS redo only. It is deliberately not a new prompt
 * version: prompts are immutable, versioned and audited (D51), and a tweak for
 * one awkward photograph must never quietly become the catalogue-wide default.
 */

export interface RedoPromptDialogProps {
  readonly filename: string
  /** Null while the resolved prompt is still being fetched. */
  readonly promptText: string | null
  readonly model: string | null
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onContinue: (promptOverride: string | null) => void
}

export function RedoPromptDialog({
  filename,
  promptText,
  model,
  busy,
  onCancel,
  onContinue,
}: RedoPromptDialogProps) {
  // The resolved prompt arrives asynchronously, after this dialog opens. Rather
  // than syncing it into state from an effect (which renders once with the
  // wrong value, then again), keep only the operator's EDIT in state and fall
  // back to the resolved text until they touch it.
  const [edit, setEdit] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusTo = useRef<Element | null>(null)

  useEffect(() => {
    returnFocusTo.current = document.activeElement
    cancelRef.current?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      // Capture + stopImmediatePropagation: the console listens for Escape on
      // window to abandon a photograph selection, and closing this dialog must
      // not also discard what the operator had selected.
      event.stopImmediatePropagation()
      event.preventDefault()
      if (!busy) onCancel()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const target = returnFocusTo.current
      if (target instanceof HTMLElement && target.isConnected) target.focus()
    }
  }, [busy, onCancel])

  const draft = edit ?? promptText ?? ''
  const edited = promptText !== null && edit !== null && edit.trim() !== promptText.trim()
  const unresolved = [...new Set(draft.match(/\{\{[A-Z_]+\}\}/gu) ?? [])]

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Review the redo prompt for ${filename}`}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-[24px] bg-surface">
        <div className="flex items-baseline gap-3 px-6 pb-3 pt-5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">Redo this image</h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {filename}
              {model ? ` · ${model}` : ''}
            </p>
          </div>
          {edited ? (
            <span className="ml-auto shrink-0 rounded-pill bg-ink px-2.5 py-1 text-[10.5px] font-medium text-white">
              edited for this product
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {promptText === null ? (
            <div className="grid h-40 place-items-center text-[12px] text-muted-foreground">
              Resolving the prompt…
            </div>
          ) : (
            <textarea
              value={draft}
              onChange={(event) => setEdit(event.target.value)}
              spellCheck={false}
              rows={18}
              aria-label="Prompt sent to the image model"
              className="loupe-scroll w-full resize-y rounded-panel bg-chip px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-6 pb-5 pt-3">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
            {unresolved.length > 0 ? (
              <span className="text-amber">
                {unresolved.join(', ')} is still in the text. The model would receive it
                literally — replace or remove it.
              </span>
            ) : edited ? (
              'This edit applies to this redo only. The saved prompt is unchanged.'
            ) : (
              'This is the exact text the image model will receive. Editing is optional.'
            )}
          </p>
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
            className="rounded-pill bg-chip px-4 py-2 text-[12px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-40"
          >
            Cancel
          </button>
          {edited ? (
            <button
              type="button"
              onClick={() => setEdit(null)}
              disabled={busy}
              className="rounded-pill bg-chip px-4 py-2 text-[12px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-40"
            >
              Reset
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onContinue(edited ? draft : null)}
            disabled={busy || promptText === null || unresolved.length > 0 || !draft.trim()}
            className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
          >
            {busy ? 'Generating…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
