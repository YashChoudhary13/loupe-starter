import { RestockScreen } from '@/components/restock/RestockScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { loadRestockQueue } from '@/lib/match/restock-read-model'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function RestockPage() {
  await requireOperator()
  const snapshot = await loadRestockQueue()
  return <RestockScreen initialSnapshot={snapshot} />
}
