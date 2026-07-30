import { ConsoleScreen } from '@/components/console/ConsoleScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { loadCatalog, loadQueue } from '@/lib/console/queue'

// Every render is a fresh authorisation check and a fresh set of presigned URLs.
// Caching either would be caching who is allowed in.
export const dynamic = 'force-dynamic'

export default async function ConsolePage() {
  // Before any data is read. An unauthenticated visitor is redirected to
  // /login and never reaches loadQueue().
  const operator = await requireOperator()
  const [queue, catalog] = await Promise.all([loadQueue(), loadCatalog()])

  return (
    <ConsoleScreen
      operator={operator}
      initialQueue={queue}
      catalog={catalog}
      initialBundle={null}
    />
  )
}
