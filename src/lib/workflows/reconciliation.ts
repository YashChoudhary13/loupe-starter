import 'server-only'

import { ShopifyClient } from '@/lib/shopify/client'

import { scanDuplicates, type ProductRef } from './duplicates-scan'
import type { StepContext, WorkflowProgram } from './runner'

/**
 * D122 — "Full reconciliation" as a step-by-step workflow. Steps 1–5 are the
 * same functions the nightly pg_cron job and the old Tracking button called;
 * step 6 is new and reports only. A step that fails on its own (webhooks,
 * draft sync, Drive) returns a warning so the drift check still runs — the
 * same tolerance the nightly job has.
 */

const ALL_VARIANTS = /* GraphQL */ `
  query LoupeWorkflowVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        sku
        product { id handle title status }
      }
    }
  }
`

interface VariantPage {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: readonly {
      sku: string | null
      product: { id: string; handle: string; title: string; status: string } | null
    }[]
  }
}

function failureText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function reconciliationProgram(): WorkflowProgram {
  return {
    steps: [
      {
        key: 'webhooks',
        label: 'Shopify webhooks',
        async run(context: StepContext) {
          try {
            const { ensureShopifyWebhooks } = await import('@/lib/shopify/webhooks')
            const result = await ensureShopifyWebhooks()
            return `${result.ensured.length} registered${result.created.length > 0 ? `, ${result.created.length} newly created` : ''}`
          } catch (cause) {
            context.log(`Webhooks: ${failureText(cause)}`)
            return { detail: `Could not check webhooks: ${failureText(cause)}`, warning: true }
          }
        },
      },
      {
        key: 'drafts',
        label: 'Reflect Shopify-side draft changes',
        async run(context: StepContext) {
          try {
            const { promotePublishedInShopify } = await import('@/lib/reconciliation/promote')
            const result = await promotePublishedInShopify(context.actor)
            for (const failure of result.failures) context.log(`Draft ${failure.draftId}: ${failure.reason}`)
            const detail = `${result.checked} drafts checked · ${result.promoted.length} published in Shopify reflected · ${result.deleted.length} deleted in Shopify removed`
            return result.failures.length > 0
              ? { detail: `${detail} · ${result.failures.length} could not be reflected`, warning: true }
              : detail
          } catch (cause) {
            context.log(`Draft sync: ${failureText(cause)}`)
            return { detail: `Draft sync failed: ${failureText(cause)}`, warning: true }
          }
        },
      },
      {
        key: 'drift',
        label: 'Compare published products',
        async run(context: StepContext) {
          const { runShopifyReconciliation } = await import('@/lib/reconciliation/server')
          const result = await runShopifyReconciliation(context.actor)
          if (!result.started) {
            return { detail: 'A catalogue check was already running; joined it instead of starting another', warning: true }
          }
          return `${result.matchedProducts} of ${result.totalProducts} published products match · ${result.issueCount} issue${result.issueCount === 1 ? '' : 's'} listed in Tracking`
        },
      },
      {
        key: 'drive',
        label: 'Tidy Drive RAW',
        async run(context: StepContext) {
          try {
            const [{ tidyPublishedDriveBacklog }, { googleDriveClient }, { serverEnv }, { supabaseServer }] =
              await Promise.all([
                import('@/lib/console/drive-backlog'),
                import('@/lib/google/drive-server'),
                import('@/lib/env'),
                import('@/lib/supabase/server'),
              ])
            const result = await tidyPublishedDriveBacklog({
              db: supabaseServer(),
              drive: googleDriveClient(),
              processedFolderId: serverEnv.driveProcessedFolderId,
              actor: context.actor,
            })
            if (result.moved === 0 && result.failed === 0) return 'RAW already clear of published photographs'
            const detail = `${result.moved} moved to Processed${result.failed > 0 ? `, ${result.failed} could not be moved` : ''}${result.more ? ' · more remain, run again' : ''}`
            return result.failed > 0 ? { detail, warning: true } : detail
          } catch (cause) {
            context.log(`Drive: ${failureText(cause)}`)
            return { detail: `Drive tidy-up failed: ${failureText(cause)}`, warning: true }
          }
        },
      },
      {
        key: 'counters',
        label: 'SKU counters',
        async run(context: StepContext) {
          const { syncSkuCountersFromShopify } = await import('@/lib/reconciliation/sync-sku-counters')
          const result = await syncSkuCountersFromShopify(context.actor)
          const notes: string[] = []
          if (result.unknownPrefixes.length > 0) {
            context.section(
              'SKU prefixes in Shopify that Loupe has no category for',
              result.unknownPrefixes.map((row) => `${row.prefix} — ${row.count} variants, highest ${row.max}`),
            )
            notes.push(`${result.unknownPrefixes.length} unknown prefix${result.unknownPrefixes.length === 1 ? '' : 'es'}`)
          }
          if (result.unparseableSkus > 0) notes.push(`${result.unparseableSkus} unparseable SKUs ignored`)
          const raised =
            result.raised.length > 0
              ? `${result.raised.map((row) => `${row.prefix} ${row.from}→${row.to}`).join(', ')} raised`
              : 'all counters already at or above Shopify'
          const detail = `${result.variantsScanned.toLocaleString('en-IN')} variants scanned · ${raised}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`
          return notes.length > 0 ? { detail, warning: true } : detail
        },
      },
      {
        key: 'duplicates',
        label: 'Duplicate SKUs and copied handles',
        async run(context: StepContext) {
          const client = new ShopifyClient()
          const variants: { sku: string | null; product: ProductRef | null }[] = []
          let cursor: string | null = null
          for (;;) {
            const page: VariantPage = await client.graphql<VariantPage>(ALL_VARIANTS, { cursor })
            for (const node of page.productVariants.nodes) {
              if (node.product?.status === 'ARCHIVED') continue
              variants.push({ sku: node.sku, product: node.product })
            }
            await context.report(`${variants.length.toLocaleString('en-IN')} variants so far`)
            if (!page.productVariants.pageInfo.hasNextPage || !page.productVariants.pageInfo.endCursor) break
            cursor = page.productVariants.pageInfo.endCursor
          }
          const scan = scanDuplicates(variants)
          if (scan.duplicateSkus.length > 0) {
            context.section(
              'One SKU on more than one product',
              scan.duplicateSkus.map(
                (row) => `${row.sku}: ${row.products.map((product) => `${product.title} (${product.handle})`).join(' · ')}`,
              ),
            )
          }
          if (scan.copiedHandles.length > 0) {
            context.section(
              'Handles still carrying Shopify\'s "-copy" suffix (public URL)',
              scan.copiedHandles.map((product) => `${product.handle} — ${product.title}`),
            )
          }
          const found = scan.duplicateSkus.length + scan.copiedHandles.length
          const detail = `${scan.duplicateSkus.length} duplicate SKU${scan.duplicateSkus.length === 1 ? '' : 's'} · ${scan.copiedHandles.length} copied handle${scan.copiedHandles.length === 1 ? '' : 's'}`
          return found > 0 ? { detail, warning: true } : detail
        },
      },
    ],
  }
}
