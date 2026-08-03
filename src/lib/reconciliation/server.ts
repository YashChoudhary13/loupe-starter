import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { buildDescriptionHtml } from '@/lib/publish/description'
import { paiseToShopifyPrice, parseSku, renderTitle } from '@/lib/publish/identity'
import { buildProductTags, PRODUCT_TYPE } from '@/lib/publish/publish-product'
import { ShopifyClient } from '@/lib/shopify/client'
import { readProductsForReconciliation } from '@/lib/shopify/reconciliation'
import { supabaseServer } from '@/lib/supabase/server'

import {
  comparePublishedProduct,
  type ExpectedReconciliationProduct,
  type ReconciliationIssue,
} from './compare'

const LEASE_SECONDS = 15 * 60
const SOURCE = 'shopify-reconciliation'
const PAGE_SIZE = 500

interface PublishedDraftRow {
  id: string
  custom_material: string | null
  description_override: string | null
  title_suffix: string | null
  price_paise: number
  weight_g: number | null
  variant_kind: 'none' | 'colour' | 'number'
  reserved_sku: string
  reserved_handle: string
  shopify_product_id: string | null
  categories?: unknown
  materials?: unknown
  product_draft_variants?: unknown
  product_draft_images?: unknown
}

interface ClaimRow {
  run_id: string
  lease_token: string | null
  owned: boolean
}

export interface ReconciliationResult {
  readonly started: boolean
  readonly runId: string
  readonly totalProducts: number
  readonly matchedProducts: number
  readonly issueCount: number
}

function one<T>(value: unknown): T | null {
  return (Array.isArray(value) ? value[0] : value) as T | null
}

function many<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : []) as T[]
}

async function publishedDraftRows(db: SupabaseClient): Promise<PublishedDraftRow[]> {
  const rows: PublishedDraftRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('product_drafts')
      .select(
        'id, custom_material, description_override, title_suffix, price_paise, weight_g, variant_kind, reserved_sku, reserved_handle, shopify_product_id, categories ( name, title_pattern, shopify_tag, default_weight_g ), materials ( name ), product_draft_variants ( position, option_value ), product_draft_images ( position, shopify_media_id )',
      )
      .eq('status', 'published')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Could not load published Loupe products: ${error.message}`)
    const page = (data ?? []) as PublishedDraftRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

function expectedProduct(row: PublishedDraftRow): {
  product: ExpectedReconciliationProduct
  localIssues: readonly ReconciliationIssue[]
} {
  const category = one<{
    name: string
    title_pattern: string
    shopify_tag: string | null
    default_weight_g: number | null
  }>(row.categories)
  const material = one<{ name: string }>(row.materials)
  const parsed = parseSku(row.reserved_sku)
  const title =
    category && parsed
      ? renderTitle(category.title_pattern, parsed.number, row.title_suffix)
      : row.reserved_sku
  const optionValues = many<{ position: number; option_value: string }>(row.product_draft_variants)
    .sort((a, b) => a.position - b.position)
    .map((variant) => variant.option_value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const media = many<{ position: number; shopify_media_id: string | null }>(
    row.product_draft_images,
  ).sort((a, b) => a.position - b.position)
  const materialName = row.custom_material?.trim() || material?.name || null
  const weightG = row.weight_g ?? category?.default_weight_g ?? 0
  const optionName: 'Colour' | 'Number' | null =
    row.variant_kind === 'colour' ? 'Colour' : row.variant_kind === 'number' ? 'Number' : null
  const variants = (optionValues.length > 0 ? optionValues : [null]).map((optionValue) => ({
    sku: row.reserved_sku,
    price: paiseToShopifyPrice(row.price_paise),
    weightG,
    optionName,
    optionValue,
  }))
  const requiredTags = category?.shopify_tag
    ? buildProductTags(category.shopify_tag)
    : ['NEWEST']

  const product: ExpectedReconciliationProduct = {
    draftId: row.id,
    shopifyProductId: row.shopify_product_id,
    handle: row.reserved_handle,
    title,
    productType: PRODUCT_TYPE,
    requiredTags,
    descriptionHtml: buildDescriptionHtml(materialName, row.description_override),
    material: materialName,
    variants,
    mediaIds: media
      .map((image) => image.shopify_media_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
    missingRecordedMedia: media.some((image) => !image.shopify_media_id),
  }
  const localIssues: ReconciliationIssue[] = []
  if (!category || !parsed) {
    localIssues.push({
      productDraftId: row.id,
      shopifyProductId: row.shopify_product_id,
      code: 'local_identity_invalid',
      field: 'identity',
      expected: 'A published draft must retain a valid category and reserved SKU.',
      actual: { category: category?.name ?? null, sku: row.reserved_sku },
      message: `${row.reserved_sku} cannot be reconstructed from Loupe's published identity.`,
    })
  }
  if (!category?.shopify_tag) {
    localIssues.push({
      productDraftId: row.id,
      shopifyProductId: row.shopify_product_id,
      code: 'local_category_tag_missing',
      field: 'tags',
      expected: 'A confirmed category tag plus NEWEST.',
      actual: requiredTags,
      message: `${title} has no confirmed category tag in Loupe.`,
    })
  }
  return { product, localIssues }
}

function safeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 2_000)
}

export async function runShopifyReconciliation(
  actor: string,
  client: ShopifyClient = new ShopifyClient(),
  db: SupabaseClient = supabaseServer(),
): Promise<ReconciliationResult> {
  const { data: claimData, error: claimError } = await db
    .rpc('claim_shopify_reconciliation', {
      p_actor: actor,
      p_lease_seconds: LEASE_SECONDS,
    })
    .select()
    .single<ClaimRow>()
  if (claimError || !claimData) {
    throw new Error(claimError?.message || 'Could not start Shopify reconciliation.')
  }
  if (!claimData.owned || !claimData.lease_token) {
    return {
      started: false,
      runId: claimData.run_id,
      totalProducts: 0,
      matchedProducts: 0,
      issueCount: 0,
    }
  }

  try {
    const shaped = (await publishedDraftRows(db)).map(expectedProduct)
    const products = shaped.map((row) => row.product)
    const ids = products
      .map((product) => product.shopifyProductId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    const actual = await readProductsForReconciliation(client, ids)
    const issues = shaped.flatMap(({ product, localIssues }) => [
      ...localIssues,
      ...comparePublishedProduct(
        product,
        product.shopifyProductId ? (actual.get(product.shopifyProductId) ?? null) : null,
      ),
    ])

    const { data: completion, error: completionError } = await db
      .rpc('complete_shopify_reconciliation', {
        p_run_id: claimData.run_id,
        p_lease_token: claimData.lease_token,
        p_total_products: products.length,
        p_issues: issues,
        p_source: SOURCE,
      })
      .select()
      .single<{
        total_products: number
        matched_products: number
        issue_count: number
      }>()
    if (completionError || !completion) {
      throw new Error(completionError?.message || 'Could not record reconciliation results.')
    }

    return {
      started: true,
      runId: claimData.run_id,
      totalProducts: completion.total_products,
      matchedProducts: completion.matched_products,
      issueCount: completion.issue_count,
    }
  } catch (error) {
    await db.rpc('fail_shopify_reconciliation', {
      p_run_id: claimData.run_id,
      p_lease_token: claimData.lease_token,
      p_error: safeFailure(error),
      p_source: SOURCE,
    })
    throw error
  }
}
