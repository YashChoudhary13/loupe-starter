import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { ShopifyClient } from '@/lib/shopify/client'
import { supabaseServer } from '@/lib/supabase/server'

import {
  planSkuCounterSync,
  scanSkuVariants,
  type ShopifySkuVariant,
} from './sku-counter-scan'

const ALL_VARIANT_SKUS = /* GraphQL */ `
  query LoupeAllVariantSkus($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        sku
        product {
          title
        }
      }
    }
  }
`

interface VariantPage {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: readonly { sku: string | null; product: { title: string } | null }[]
  }
}

export interface SkuCounterSyncResult {
  readonly variantsScanned: number
  readonly raised: readonly {
    readonly prefix: string
    readonly from: number
    readonly to: number
  }[]
  readonly countersChecked: number
  readonly blankSkus: number
  readonly unparseableSkus: number
  readonly excludedMalformedSkus: number
  readonly unknownPrefixes: readonly {
    readonly prefix: string
    readonly max: number
    readonly count: number
  }[]
}

/** Reads every Shopify variant because SKUs live on variants, not products. */
async function readEveryShopifySku(shopify: ShopifyClient): Promise<ShopifySkuVariant[]> {
  const variants: ShopifySkuVariant[] = []
  let cursor: string | null = null

  for (;;) {
    const data: VariantPage = await shopify.graphql<VariantPage>(ALL_VARIANT_SKUS, { cursor })
    for (const node of data.productVariants.nodes) {
      variants.push({ sku: node.sku, title: node.product?.title ?? '(no product)' })
    }

    if (!data.productVariants.pageInfo.hasNextPage) return variants
    cursor = data.productVariants.pageInfo.endCursor
    if (!cursor) return variants
  }
}

/**
 * Reconciles future SKU allocation with Shopify without renumbering history.
 *
 * Only `raise_sku_counter()` may write, so a deleted product or stale Shopify
 * page can never lower a sequence or make an already-used number available
 * again. Unknown prefixes are reported and never invented.
 */
export async function syncSkuCountersFromShopify(
  actor: string,
  shopify: ShopifyClient = new ShopifyClient(),
  db: SupabaseClient = supabaseServer(),
): Promise<SkuCounterSyncResult> {
  const [{ data: categories, error: categoryError }, { data: counters, error: counterError }] =
    await Promise.all([
      db.from('categories').select('sku_prefix'),
      db.from('sku_counters').select('sku_prefix, last_number'),
    ])
  if (categoryError) throw new Error(`Could not read SKU categories: ${categoryError.message}`)
  if (counterError) throw new Error(`Could not read SKU counters: ${counterError.message}`)

  const knownPrefixes = new Set((categories ?? []).map((row) => row.sku_prefix as string))
  const counterStates = (counters ?? [])
    .map((row) => ({
      prefix: row.sku_prefix as string,
      current: row.last_number as number,
    }))
    .filter((row) => knownPrefixes.has(row.prefix))

  const scan = scanSkuVariants(await readEveryShopifySku(shopify))
  const plan = planSkuCounterSync(counterStates, scan.findings)
  const raised: { prefix: string; from: number; to: number }[] = []

  for (const row of plan) {
    if (row.action !== 'raise' || row.shopifyMax === null) continue
    const { data, error } = await db.rpc('raise_sku_counter', {
      p_prefix: row.prefix,
      p_to: row.shopifyMax,
    })
    if (error) {
      throw new Error(`Could not raise ${row.prefix} SKU counter: ${error.message}`)
    }
    raised.push({ prefix: row.prefix, from: row.from, to: data as number })
  }

  const unknownPrefixes = [...scan.findings.values()]
    .filter((finding) => !knownPrefixes.has(finding.prefix))
    .map((finding) => ({
      prefix: finding.prefix,
      max: finding.max,
      count: finding.count,
    }))
    .sort((left, right) => left.prefix.localeCompare(right.prefix))

  const result: SkuCounterSyncResult = {
    variantsScanned: scan.scanned,
    raised,
    countersChecked: plan.length,
    blankSkus: scan.blank,
    unparseableSkus: scan.unparseable.length,
    excludedMalformedSkus: scan.excludedMalformed.length,
    unknownPrefixes,
  }

  const { error: eventError } = await db.from('events').insert({
    entity_type: 'system',
    event: 'reconciliation.sku_counters',
    detail: {
      variants_scanned: result.variantsScanned,
      counters_checked: result.countersChecked,
      raised: result.raised,
      unknown_prefixes: result.unknownPrefixes,
      blank_skus: result.blankSkus,
      unparseable_skus: result.unparseableSkus,
      excluded_malformed_skus: scan.excludedMalformed,
    },
    actor,
  })
  if (eventError) {
    throw new Error(`SKU counters were checked, but the audit event failed: ${eventError.message}`)
  }

  return result
}
