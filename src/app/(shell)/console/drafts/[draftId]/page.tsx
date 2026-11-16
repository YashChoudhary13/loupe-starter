import { notFound } from 'next/navigation'

import { ConsoleScreen } from '@/components/console/ConsoleScreen'
import { requireOperatorWith } from '@/lib/auth/authorize'
import { describeBlocks } from '@/lib/console/publish'
import { loadCatalog, loadColourSuggestions, loadDraft, loadQueue } from '@/lib/console/queue'

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
  const { draftId } = await params

  // The draft, the queue, the catalogue and the publish blocks do not depend on each other, so they are read
  // together, alongside the sign-in check (D174). Only the colour suggestions wait, for the draft's category.
  const loaded = await requireOperatorWith(async () => {
    const others = Promise.all([loadQueue(), loadCatalog(), describeBlocks(draftId, false)])
    others.catch(() => {}) // a draft that does not exist is a 404, whatever else failed
    const draft = await loadDraft(draftId)
    if (!draft) return null
    const [colours, [queue, catalog, blocks]] = await Promise.all([loadColourSuggestions(draft.categoryId), others])
    return { draft, colours, queue, catalog, blocks }
  })
  if (!loaded) notFound()
  const { draft, colours, queue, catalog, blocks } = loaded

  return (
    <ConsoleScreen
      initialQueue={queue}
      catalog={catalog}
      initialBundle={{ draft, colours, blocks }}
    />
  )
}
