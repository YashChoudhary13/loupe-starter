import { Sidebar } from '@/components/console/Sidebar'
import { requireOperator } from '@/lib/auth/authorize'
import {
  loadPromptLibrary,
  type PromptKind,
  type PromptVersion,
} from '@/lib/prompts/library'

export const dynamic = 'force-dynamic'

export default async function PromptsPage() {
  const operator = await requireOperator()
  const prompts = await loadPromptLibrary()

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
        </article>
      ) : (
        <p className="mt-4 rounded-panel bg-[#fff7e8] p-4 text-[12px] text-amber">
          No current prompt. Enhancement will refuse to run until one is restored.
        </p>
      )}

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
                </div>
                <span className="rounded-pill bg-chip px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-ink-soft">
                  {version.isDefault && version.archivedAt === null ? 'current' : 'archived'}
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
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
