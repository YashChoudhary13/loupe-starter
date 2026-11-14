import { EnhanceScreen } from '@/components/enhance/EnhanceScreen'
import { listJobs } from '@/lib/agent-jobs/server'
import { runnerView } from '@/lib/agent-jobs/tracking-server'
import { requireOperator } from '@/lib/auth/authorize'

export const dynamic = 'force-dynamic'

export default async function EnhancePage() {
  await requireOperator()
  const [jobs, runner] = await Promise.all([listJobs(), runnerView()])
  return <EnhanceScreen initialJobs={jobs} initialRunner={runner} />
}
