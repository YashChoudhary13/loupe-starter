import { ParcelsScreen } from '@/components/find/ParcelsScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { listParcels } from '@/lib/find/server'

export const dynamic = 'force-dynamic'

export default async function ParcelsPage() {
  await requireOperator('/find/parcels')
  return <ParcelsScreen initial={await listParcels()} />
}
