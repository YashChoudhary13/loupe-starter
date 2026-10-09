import { EnhanceScreen } from '@/components/enhance/EnhanceScreen'
import { listJobs } from '@/lib/agent-jobs/server'
import { requireOperator } from '@/lib/auth/authorize'

export const dynamic = 'force-dynamic'

export default async function EnhancePage() {
  await requireOperator()
  const jobs = await listJobs()
  return <EnhanceScreen initialJobs={jobs} />
}
