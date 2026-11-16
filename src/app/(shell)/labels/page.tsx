import { requireOperatorWith } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { searchLabelVariants, type LabelVariant } from '@/lib/labels/catalogue'
import { LabelsScreen } from '@/components/labels/LabelsScreen'

export const dynamic = 'force-dynamic'

export default async function LabelsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q: rawQuery } = await searchParams
  const q = typeof rawQuery === 'string' ? rawQuery : ''
  let variants: LabelVariant[] = []
  let error: string | undefined
  const [found] = await requireOperatorWith(() => Promise.allSettled([q ? searchLabelVariants(new ShopifyClient(), q) : Promise.resolve<LabelVariant[]>([])]))
  if (found.status === 'fulfilled') variants = found.value; else error = found.reason instanceof Error ? found.reason.message : 'Could not load Shopify variants. Try again.'
  return <LabelsScreen query={q} variants={variants} error={error} />
}
