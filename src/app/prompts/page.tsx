import { Sidebar } from '@/components/console/Sidebar'
import { requireOperator } from '@/lib/auth/authorize'
import { curatedModel, modelsFor } from '@/lib/prompts/models'
import {
  loadPromptLibrary,
  type PromptKind,
  type PromptVersion,
} from '@/lib/prompts/library'

import {
  createPromptVersionAction,
  promotePromptVersionAction,
  selectPromptModelAction,
} from './actions'

export const dynamic = 'force-dynamic'

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{
    updated?: string
    created?: string
    promoted?: string
    error?: string
  }>
}) {
  const operator = await requireOperator()
  const prompts = await loadPromptLibrary()
  const feedback = await searchParams

  return (
    <div className="grid min-h-dvh grid-cols-[216px_1fr] gap-[18px] p-[18px]">
      <Sidebar operator={operator} attentionCount={0} active="prompts" />

      <main className="min-w-0">
        <header className="mb-4">
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Prompts</h1>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Current enhancement instructions and their immutable history.
          </p>
        </header>

        {feedback.updated ? (
          <p className="mb-3.5 rounded-panel bg-surface px-4 py-3 text-[12px] text-ink-soft">
            Model updated. New {feedback.updated === 'describe' ? 'descriptions' : 'images'} use
            it; existing results stay unchanged.
          </p>
        ) : null}
        {feedback.created ? (
          <p className="mb-3.5 rounded-panel bg-surface px-4 py-3 text-[12px] text-ink-soft">
            New {feedback.created === 'describe' ? 'descriptor' : 'image'} prompt version saved.
            The current prompt did not change.
          </p>
        ) : null}
        {feedback.promoted ? (
          <p className="mb-3.5 rounded-panel bg-surface px-4 py-3 text-[12px] text-ink-soft">
            Prompt promoted. New enhancement work uses it; prior versions and images stay
            unchanged.
          </p>
        ) : null}
        {feedback.error ? (
          <p className="mb-3.5 rounded-panel bg-[#fff7e8] px-4 py-3 text-[12px] text-amber">
            {feedback.error}
          </p>
        ) : null}

        <div className="grid gap-3.5 xl:grid-cols-2">
          <PromptGroup kind="describe" versions={prompts.describe} />
          <PromptGroup kind="image" versions={prompts.image} />
        </div>
      </main>
    </div>
  )
}

function PromptGroup({
  kind,
  versions,
}: {
  kind: PromptKind
  versions: readonly PromptVersion[]
}) {
  const current = versions.find((version) => version.isDefault && version.archivedAt === null)
  const currentModel = current ? curatedModel(kind, current.model) : null
  const options = modelsFor(kind)

  return (
    <section className="rounded-card bg-surface p-6">
      <div className="flex items-start gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.13em] text-muted-foreground">
            {kind === 'describe' ? 'Step 1' : 'Step 2'}
          </p>
          <h2 className="mt-1 text-[17px] font-medium">
            {kind === 'describe' ? 'Describe product' : 'Generate image'}
          </h2>
        </div>
        <span className="ml-auto rounded-pill bg-chip px-2.5 py-1 text-[10px] text-ink-soft">
          {versions.length} {versions.length === 1 ? 'version' : 'versions'}
        </span>
      </div>

      {current ? (
        <article className="mt-4 rounded-panel bg-ink p-4 text-white">
          <div className="flex items-center gap-2">
            <span className="rounded-pill bg-white/15 px-2 py-0.5 text-[9px] uppercase tracking-[0.1em]">
              Current
            </span>
            <span className="truncate text-[12px] font-medium">{current.name}</span>
          </div>
          <p className="mt-3 max-h-[340px] overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-white/75">
            {current.body}
          </p>
          <form
            action={selectPromptModelAction}
            className="mt-4 border-t border-white/15 pt-4"
          >
            <input type="hidden" name="kind" value={kind} />
            <label
              htmlFor={`${kind}-model`}
              className="text-[9px] uppercase tracking-[0.12em] text-white/55"
            >
              {kind === 'describe' ? 'Descriptor model' : 'Image generation model'}
            </label>
            <div className="mt-2 flex gap-2">
              <select
                id={`${kind}-model`}
                name="model"
                defaultValue={current.model}
                className="min-w-0 flex-1 rounded-field bg-white px-3 py-2 text-[11.5px] text-ink outline-none focus:ring-2 focus:ring-white/40"
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.tier} · {option.label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="shrink-0 rounded-pill bg-white px-3.5 py-2 text-[11px] font-medium text-ink transition-colors hover:bg-[#ededee]"
              >
                Use model
              </button>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-white/55">
              {currentModel?.priceHint ?? current.model}
              {currentModel ? ` · ${currentModel.note}` : ''}
            </p>
          </form>
        </article>
      ) : (
        <p className="mt-4 rounded-panel bg-[#fff7e8] p-4 text-[12px] text-amber">
          No current prompt. Enhancement will refuse to run until one is restored.
        </p>
      )}

      <details className="mt-4 rounded-panel border border-[#e7e7e9] p-4">
        <summary className="cursor-pointer select-none text-[11.5px] font-medium text-ink">
          Create a new version
        </summary>
        <form action={createPromptVersionAction} className="mt-4">
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
            defaultValue={current?.name ?? ''}
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
            defaultValue={current?.body ?? ''}
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
            defaultValue={current?.model ?? options[0]?.id}
            className="mt-1.5 w-full rounded-field bg-chip px-3 py-2.5 text-[11.5px] text-ink outline-none focus:ring-2 focus:ring-ink/15"
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.tier} · {option.label}
              </option>
            ))}
          </select>
          {kind === 'image' ? (
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
              Keep exactly one PRODUCT block and one {'{{COMPOSITION_DETAIL}}'} token.
              Loupe checks both before saving and again before promotion.
            </p>
          ) : null}
          <button
            type="submit"
            className="mt-3 rounded-pill bg-ink px-4 py-2 text-[11px] font-medium text-white transition-colors hover:bg-[#242428]"
          >
            Save new version
          </button>
        </form>
      </details>

      <div className="mt-5">
        <p className="text-[10px] uppercase tracking-[0.13em] text-muted-foreground">History</p>
        <ol className="mt-2 divide-y divide-[#ececee]">
          {versions.map((version) => (
            <li key={version.id} className="py-3 first:pt-1">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-ink">{version.name}</p>
                  <p className="mt-1 text-[10.5px] text-muted-foreground">
                    {new Date(version.createdAt).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'Asia/Kolkata',
                    })}
                    {version.createdBy ? ` · ${version.createdBy}` : ''}
                  </p>
                  <p className="mt-1 truncate font-mono text-[9.5px] text-muted-foreground">
                    {version.model}
                  </p>
                </div>
                <span className="rounded-pill bg-chip px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-ink-soft">
                  {version.isDefault && version.archivedAt === null
                    ? 'current'
                    : version.archivedAt === null
                      ? 'ready'
                      : 'archived'}
                </span>
              </div>
              {version !== current ? (
                <details className="mt-2 text-[11px] text-ink-soft">
                  <summary className="cursor-pointer select-none">View prompt</summary>
                  <p className="mt-2 whitespace-pre-wrap rounded-field bg-chip p-3 leading-relaxed">
                    {version.body}
                  </p>
                </details>
              ) : null}
              {version !== current ? (
                <form action={promotePromptVersionAction} className="mt-2">
                  <input type="hidden" name="promptId" value={version.id} />
                  <button
                    type="submit"
                    className="rounded-pill bg-chip px-3 py-1.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:bg-[#ebebeb]"
                  >
                    Promote this version
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
