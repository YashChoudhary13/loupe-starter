import { TrackingScreen } from '@/components/tracking/TrackingScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { loadTracking } from '@/lib/tracking/read-model'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export default async function TrackingPage() {
  await requireOperator()
  const snapshot = await loadTracking()
  return <TrackingScreen initialSnapshot={snapshot} />
}
