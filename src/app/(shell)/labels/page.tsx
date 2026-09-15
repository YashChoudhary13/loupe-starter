import { requireOperator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { searchLabelVariants, type LabelVariant } from '@/lib/labels/catalogue'
import { LabelsScreen } from '@/components/labels/LabelsScreen'

export const dynamic = 'force-dynamic'

export default async function LabelsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireOperator()
  const { q: rawQuery } = await searchParams
  const q = typeof rawQuery === 'string' ? rawQuery : ''
  let variants: LabelVariant[] = []
  let error: string | undefined
  if (q) {
    try { variants = await searchLabelVariants(new ShopifyClient(), q) }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load Shopify variants. Try again.' }
  }
  return <LabelsScreen query={q} variants={variants} error={error} />
}
