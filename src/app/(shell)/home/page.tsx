import { HomeScreen } from '@/components/home/HomeScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { homeSnapshot } from '@/lib/home/server'

export const dynamic = 'force-dynamic'

/** Health lights, five numbers and the assistant. Lights are at most 30 s old and numbers 60 s (in-process caches, D137); every render is authenticated. */
export default async function HomePage() {
  await requireOperator()
  return <HomeScreen {...await homeSnapshot()} />
}
