import { RestockScreen } from '@/components/restock/RestockScreen'
import { loadRestockCandidates } from '@/lib/agent-intake/restock'
import { requireOperator } from '@/lib/auth/authorize'
import { loadRestockQueue } from '@/lib/match/restock-read-model'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function RestockPage() {
  await requireOperator()
  const [snapshot, candidates] = await Promise.all([loadRestockQueue(), loadRestockCandidates()])
  return <RestockScreen initialSnapshot={snapshot} initialCandidates={candidates} />
}
