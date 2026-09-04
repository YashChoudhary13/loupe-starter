import { WorkflowsScreen } from '@/components/workflows/WorkflowsScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { listWorkflowRuns } from '@/lib/workflows/runner'

export const dynamic = 'force-dynamic'

/**
 * D122 — the Workflows section: every store-wide check or repair as one
 * button with a live step timeline. Runs are durable rows, so the page shows
 * what any operator started, and a reload never loses a run in progress.
 */
export default async function WorkflowsPage() {
  await requireOperator()
  const runs = await listWorkflowRuns()

  return (
    <main className="loupe-scroll min-h-0 min-w-0 overflow-y-auto pr-1">
      <header className="mb-4">
        <h1 className="text-[26px] font-medium tracking-[-0.025em]">Workflows</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Store-wide checks and repairs, one press each. Steps light up as they run; press another
          workflow while one is going. Every run is recorded with what it found.
        </p>
      </header>
      <WorkflowsScreen initialRuns={runs} />
    </main>
  )
}
