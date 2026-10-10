/** Explicit opt-in: creates and deletes one isolated, zero-stock Shopify DRAFT watch. Never touches orders or real products. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { ShopifyClient } from '../src/lib/shopify/client'
import { productSet, primaryLocationId, type ProductSetArgs } from '../src/lib/shopify/product-set'
import { syncShopifySavedColours } from '../src/lib/shopify/colour-options'

const WATCHES = 'gid://shopify/TaxonomyCategory/aa-6-11'
const READBACK = /* GraphQL */ `
  query VerifyWatchColour($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      status
      category { id }
      options { name linkedMetafield { namespace key } optionValues { name swatch { color } } }
    }
  }
`
interface Readback {
  productByIdentifier: {
    id: string
    status: string
    category: { id: string } | null
    options: { name: string; linkedMetafield: { namespace: string | null; key: string | null } | null; optionValues: { name: string; swatch: { color: string | null } | null }[] }[]
  } | null
}

async function main() {
  if (process.argv[2] !== '--create-test-draft' || !process.argv[3]) throw new Error('Usage: --create-test-draft <env-file>')
  Object.assign(process.env, parse(readFileSync(process.argv[3])))
  const client = new ShopifyClient()
  const nonce = Date.now().toString()
  const handle = `loupe-watch-colour-verification-${nonce}`
  // Both entries already exist in the store, so nothing is created for them.
  const colours = await syncShopifySavedColours(client, ['White', 'Red'])
  const locationId = await primaryLocationId(client)
  const args: ProductSetArgs = {
    handle,
    title: 'LOUPE WATCH COLOUR VERIFICATION — DO NOT SELL',
    status: 'DRAFT',
    productType: 'Jewellery',
    descriptionHtml: '<p>Temporary automated verification. Zero stock.</p>',
    tags: ['loupe-verification'],
    material: null,
    categoryId: WATCHES,
    optionName: 'Color',
    variants: colours.map((colour, index) => ({
      sku: `LOUPEVERIFY${nonce}-${index + 1}`,
      price: '1.00',
      weightG: 0,
      stock: 0,
      locationId,
      optionValue: colour.name,
      linkedMetafieldValue: colour.metaobjectId,
    })),
  }
  let createdId: string | null = null
  try {
    createdId = (await productSet(client, args)).id
    const product = (await client.graphql<Readback>(READBACK, { handle })).productByIdentifier
    assert.equal(product?.status, 'DRAFT')
    assert.equal(product?.category?.id, WATCHES)
    assert.equal(product?.options.length, 1)
    const option = product!.options[0]
    assert.equal(option.name, 'Color')
    assert.deepEqual(option.linkedMetafield, { namespace: 'shopify', key: 'dial-color' })
    assert.deepEqual(option.optionValues.map((value) => value.name), ['White', 'Red'])
    assert.ok(option.optionValues.every((value) => value.swatch?.color), 'every colour carries its swatch')
    console.log(`Shopify accepted a DRAFT watch with option "${option.name}" (${option.optionValues.map((v) => `${v.name} ${v.swatch?.color}`).join(', ')}), linked to shopify.dial-color.`)
  } finally {
    if (!createdId) createdId = (await client.graphql<Readback>(READBACK, { handle })).productByIdentifier?.id ?? null
    if (createdId) {
      const removed = await client.graphql<{ productDelete: { deletedProductId: string | null; userErrors: { message: string }[] } }>(
        'mutation RemoveVerification($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }',
        { input: { id: createdId } },
      )
      assert.equal(removed.productDelete.deletedProductId, createdId)
      assert.equal((await client.graphql<Readback>(READBACK, { handle })).productByIdentifier, null)
      console.log('Removed only the temporary verification product; absence verified.')
    }
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
