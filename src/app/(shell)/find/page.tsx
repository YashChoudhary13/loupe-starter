import { FindScreen } from '@/components/find/FindScreen'
import { requireOperator } from '@/lib/auth/authorize'

export const dynamic = 'force-dynamic'

/** Find (D173). The page itself reads nothing: the field is on screen at once and every look-up is a fetch of /api/find. */
export default async function FindPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams
  await requireOperator(typeof q === 'string' && q ? `/find?q=${encodeURIComponent(q)}` : '/find')
  return <FindScreen initialQuery={typeof q === 'string' ? q.slice(0, 40) : ''} />
}
