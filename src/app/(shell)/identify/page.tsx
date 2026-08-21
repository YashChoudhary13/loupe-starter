import { IdentifyScreen } from '@/components/identify/IdentifyScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { loadIdentifyQueue } from '@/lib/match/read-model'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function IdentifyPage() {
  await requireOperator()
  const snapshot = await loadIdentifyQueue()
  return <IdentifyScreen initialSnapshot={snapshot} />
}
