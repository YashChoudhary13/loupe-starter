import { createHash } from 'node:crypto'
import type { ShopifyClient } from '@/lib/shopify/client'
import { findCodeMatches } from '@/lib/shopify/barcode-lookup'
import { parentSku, variantSku } from '@/lib/publish/variant-sku'
import { searchLabelVariants } from './catalogue'

interface SavedVariant {
  id: string; sku: string | null; barcode: string | null; title: string
  selectedOptions: { name: string; value: string }[]
}
export interface CodePlan {
  productId: string; productTitle: string; parent: string; fingerprint: string
  rows: { id: string; title: string; oldSku: string | null; sku: string; oldBarcode: string | null; barcode: string }[]
}

/** Only SKU and Barcode are ever sent by this path. Existing variant IDs stay fixed. */
export async function planProductCodes(client: ShopifyClient, productId: string): Promise<CodePlan> {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) throw new Error('Choose a product from Labels.')
  const { product } = await client.graphql<{ product: null | { id: string; title: string; variants: { nodes: SavedVariant[]; pageInfo: { hasNextPage: boolean } } } }>(`
    query LoupePrepareCodes($id: ID!) { product(id: $id) { id title variants(first: 250) {
      nodes { id sku barcode title selectedOptions { name value } } pageInfo { hasNextPage }
    } } }`, { id: productId })
  if (!product || product.variants.pageInfo.hasNextPage || !product.variants.nodes.length) throw new Error('Choose an existing product with 1–250 variants.')
  const variants = product.variants.nodes
  const parents = new Set(variants.map(v => parentSku(v.sku ?? '')))
  if (parents.size !== 1 || parents.has(null)) throw new Error('These variants do not share one valid Qimati product number. Correct their SKUs in Shopify first.')
  const parent = [...parents][0]!
  const family = await searchLabelVariants(client, parent)
  if (family.some(v => v.product.id !== productId) || variants.some(v => !family.some(f => f.id === v.id))) throw new Error('This product number is shared by another product, or Shopify search is still updating. Resolve duplicate product numbers or retry shortly.')
  const rows = variants.map(v => {
    const options = v.selectedOptions.filter(o => o.name !== 'Title')
    const colour = options.find(o => /^(colou?r)$/i.test(o.name))
    const size = options.find(o => /^size$/i.test(o.name))
    const number = options.find(o => /^number$/i.test(o.name))
    // Keep an already-distinct identifier, so repeat preparations never relabel renamed choices.
    let sku = v.sku!
    if (sku === parent || variants.filter(other => other.sku === sku).length > 1) {
      if (!options.length && variants.length === 1) sku = parent
      else if (colour && size && options.length === 2) sku = variantSku(parent, 'colour_size', colour.value, 'variant-v1', size.value)
      else if (options.length === 1 && (colour || size || number)) sku = variantSku(parent, colour ? 'colour' : size ? 'size' : 'number', options[0].value, 'variant-v1')
      // Unusual historical option names still get a stable unique identity by Shopify variant ID.
      else sku = variantSku(parent, 'number', v.id.split('/').at(-1)!, 'variant-v1')
    }
    const barcode = !v.barcode || v.barcode === parent ? sku : v.barcode
    return { id: v.id, title: v.title, oldSku: v.sku, sku, oldBarcode: v.barcode, barcode }
  })
  if (new Set(rows.map(v => v.sku)).size !== rows.length || new Set(rows.map(v => v.barcode)).size !== rows.length) throw new Error('Some options produce the same code. Give those options distinct names in Shopify before preparing labels.')
  for (const row of rows) {
    if (!/^[\x21-\x7e]{1,64}$/.test(row.barcode)) throw new Error('A saved barcode is too long or contains unsupported characters. Correct it in Shopify first.')
    for (const code of new Set([row.sku, row.barcode])) {
      const matches = await findCodeMatches(client, code)
      if (matches.some(match => match.id !== row.id)) throw new Error(`Code ${code} also identifies another variant. Correct the duplicate in Shopify first.`)
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ productId, variants })).digest('hex')
  return { productId, productTitle: product.title, parent, fingerprint, rows }
}

export async function applyProductCodes(client: ShopifyClient, plan: CodePlan): Promise<void> {
  const variants = plan.rows.filter(r => r.oldSku !== r.sku || r.oldBarcode !== r.barcode)
  if (!variants.length) return
  const result = await client.graphql<{ productVariantsBulkUpdate: { userErrors: { message: string }[]; productVariants: { id: string; sku: string | null; barcode: string | null }[] | null } }>(`
    mutation LoupePrepareVariantCodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
        productVariants { id sku barcode } userErrors { message }
      }
    }`, { productId: plan.productId, variants: variants.map(row => ({ id: row.id, barcode: row.barcode, inventoryItem: { sku: row.sku } })) })
  const payload = result.productVariantsBulkUpdate
  if (payload.userErrors.length) throw new Error(payload.userErrors.map(e => e.message).join('; '))
  if (variants.some(row => !payload.productVariants?.some(saved => saved.id === row.id && saved.sku === row.sku && saved.barcode === row.barcode))) throw new Error('Shopify did not confirm every code. Reload Labels and check the saved values before printing.')
}
