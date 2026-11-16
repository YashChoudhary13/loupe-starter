import { ConsoleScreen } from '@/components/console/ConsoleScreen'
import { requireOperatorWith } from '@/lib/auth/authorize'
import { loadCatalog, loadQueue } from '@/lib/console/queue'

// Every render is a fresh authorisation check and a fresh set of presigned URLs.
// Caching either would be caching who is allowed in.
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export default async function ConsolePage() {
  // A visitor without a session is redirected and never reaches loadQueue(). With one, the operator's row is
  // checked while the queue is read, and nothing is shown unless that check passes (D174).
  const [queue, catalog] = await requireOperatorWith(() => Promise.all([loadQueue(), loadCatalog()]))

  return <ConsoleScreen initialQueue={queue} catalog={catalog} initialBundle={null} />
}
