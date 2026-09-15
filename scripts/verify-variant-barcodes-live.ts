/** Explicit opt-in: creates and deletes one isolated, zero-stock Shopify DRAFT. Never touches orders. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { ShopifyClient } from '../src/lib/shopify/client'
import { productSet, readProductByHandle, primaryLocationId, type ProductSetArgs } from '../src/lib/shopify/product-set'
import { syncShopifySavedColours } from '../src/lib/shopify/colour-options'
import { variantSkus } from '../src/lib/publish/variant-sku'
import { assertVariantCodesAvailable } from '../src/lib/shopify/barcode-lookup'

async function main() {
  if (process.argv[2] !== '--create-test-draft' || !process.argv[3] || !process.argv[4]) throw new Error('Usage: --create-test-draft <env-file> <receipt-file>')
  Object.assign(process.env, parse(readFileSync(process.argv[3])))
  const client = new ShopifyClient()
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: category, error } = await db.from('categories').select('shopify_taxonomy_category_id').eq('sku_prefix', 'RS').single()
  if (error || !category?.shopify_taxonomy_category_id) throw new Error('Could not read ring taxonomy.')
  const pairs = [{ value: 'Gold', sizeValue: '7' }, { value: 'Gold', sizeValue: '8' }, { value: 'Silver', sizeValue: '8' }]
  const nonce = Date.now().toString()
  const base = `QC${nonce}`
  const handle = `loupe-qc-verification-${nonce}`
  const codes = variantSkus(base, 'colour_size', pairs, 'variant-v1')
  await assertVariantCodesAvailable(client, codes, null)
  const colours = await syncShopifySavedColours(client, ['Gold', 'Silver'])
  const locationId = await primaryLocationId(client)
  const args: ProductSetArgs = { handle, title: 'LOUPE QC VERIFICATION — DO NOT SELL', status: 'DRAFT', productType: 'Jewellery', descriptionHtml: '<p>Temporary automated verification. Zero stock.</p>', tags: ['loupe-qc-verification'], material: null, categoryId: category.shopify_taxonomy_category_id, optionName: 'Color', secondaryOptionName: 'Size', variants: pairs.map((v,i) => ({ sku: codes[i], barcode: codes[i], price: '1.00', weightG: 1, stock: 0, locationId, optionValue: v.value, sizeValue: v.sizeValue, linkedMetafieldValue: colours.find(c => c.name.toLowerCase() === v.value.toLowerCase())!.metaobjectId })) }
  let createdId: string | null = null
  try {
    const product = await productSet(client, args)
    createdId = product.id
    const before = await readProductByHandle(client,handle)
    assert.equal(before?.status,'DRAFT')
    assert.equal(before?.variants.nodes.length,3)
    const input = [...args.variants].reverse().map(v=>({...v,id:before!.variants.nodes.find(n=>n.sku===v.sku)!.id}))
    await productSet(client,{...args,variants:input})
    const after = await readProductByHandle(client,handle)
    const values = await client.graphql<{nodes:{id:string;sku:string;barcode:string;inventoryQuantity:number}[]}>(`query VerifyBarcodeValues($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id sku barcode inventoryQuantity}}}`,{ids:before!.variants.nodes.map(v=>v.id)})
    assert.equal(after?.status,'DRAFT')
    assert.equal(after?.variants.nodes.length,3)
    for(const row of values.nodes) { assert.equal(row.sku,row.barcode);assert.equal(row.inventoryQuantity,0);assert.equal(after?.variants.nodes.find(v=>v.sku===row.sku)?.id,row.id) }
    writeFileSync(process.argv[4],JSON.stringify({store:client.config.storeDomain,productId:createdId,handle,status:'DRAFT',codes:values.nodes,variantIdsPreservedAcrossReorder:true,realOrdersTouched:false,cleanup:'pending'},null,2))
    console.log('Verified 3 sparse pairs; matching SKU/barcode; zero stock; variant IDs preserved after reorder.')
  } finally {
    if (!createdId) createdId = (await readProductByHandle(client,handle))?.id ?? null
    if(createdId) {
      const removed=await client.graphql<{productDelete:{deletedProductId:string|null;userErrors:{message:string}[]}}>('mutation RemoveVerification($input:ProductDeleteInput!){productDelete(input:$input){deletedProductId userErrors{message}}}',{input:{id:createdId}})
      assert.equal(removed.productDelete.deletedProductId,createdId)
      assert.equal(await readProductByHandle(client,handle),null)
      try { const receipt=JSON.parse(readFileSync(process.argv[4],'utf8'));receipt.cleanup='deleted and absence verified';writeFileSync(process.argv[4],JSON.stringify(receipt,null,2)) } catch {}
      console.log('Removed only the temporary verification product; absence verified.')
    }
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1})
