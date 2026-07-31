import { notFound } from 'next/navigation'

import { ConsoleScreen } from '@/components/console/ConsoleScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { describeBlocks } from '@/lib/console/publish'
import { loadCatalog, loadColourSuggestions, loadDraft, loadQueue } from '@/lib/console/queue'
import { loadTrackingAttentionCount } from '@/lib/tracking/read-model'

export const dynamic = 'force-dynamic'

/**
 * A draft addressed directly by URL.
 *
 * This is what "the operator can close the browser and resume later" looks like
 * in practice — a link that reopens the exact product with its grouping, its
 * chosen versions, its order and its fields, all read back from Postgres rather
 * than from anything the last session left behind.
 */
export default async function DraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>
}) {
  const operator = await requireOperator()
  const { draftId } = await params

  const draft = await loadDraft(draftId)
  if (!draft) notFound()

  const [queue, catalog, colours, blocks, trackingAttentionCount] = await Promise.all([
    loadQueue(),
    loadCatalog(),
    loadColourSuggestions(draft.categoryId),
    describeBlocks(draftId, false),
    loadTrackingAttentionCount(),
  ])

  return (
    <ConsoleScreen
      operator={operator}
      initialQueue={queue}
      catalog={catalog}
      initialBundle={{ draft, colours, blocks }}
      trackingAttentionCount={trackingAttentionCount}
    />
  )
}
