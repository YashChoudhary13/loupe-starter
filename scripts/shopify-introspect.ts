/**
 * Asks Shopify what its schema actually looks like.
 *
 *   npm run shopify:introspect
 *
 * The `productSet` input types are large, they move between API versions, and the
 * cost of being wrong is a `userErrors` message at publish time rather than a
 * compile error. This prints the fields Loupe depends on so a mismatch is a
 * ten-second check instead of an afternoon.
 *
 * Run it after bumping SHOPIFY_API_VERSION, and the first time the app is
 * installed on a new store.
 */
import { config } from 'dotenv'

import { ShopifyClient } from '../src/lib/shopify/client'
import { shopifyConfig } from '../src/lib/shopify/config'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const TYPES = [
  'ProductSetInput',
  'ProductVariantSetInput',
  'ProductSetIdentifiers',
  'ProductSetInventoryInput',
  'InventoryItemInput',
  'InventoryItemMeasurementInput',
  'WeightInput',
  'OptionSetInput',
  'OptionValueSetInput',
  'VariantOptionValueInput',
  'MetafieldInput',
  // Phase 4 — product images are published through productSet's `files`, so the
  // media API's shape is now something a publish depends on being right about.
  'FileSetInput',
  'FileContentType',
  'FileDuplicateResolutionMode',
]

const QUERY = /* GraphQL */ `
  query LoupeIntrospect($name: String!) {
    __type(name: $name) {
      name
      kind
      inputFields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
      enumValues {
        name
      }
    }
  }
`

interface TypeRef {
  kind: string
  name: string | null
  ofType?: TypeRef | null
}

interface IntrospectResponse {
  __type: {
    name: string
    kind: string
    inputFields: readonly { name: string; type: TypeRef }[] | null
    enumValues: readonly { name: string }[] | null
  } | null
}

function renderType(t: TypeRef | null | undefined): string {
  if (!t) return '?'
  if (t.kind === 'NON_NULL') return `${renderType(t.ofType)}!`
  if (t.kind === 'LIST') return `[${renderType(t.ofType)}]`
  return t.name ?? '?'
}

async function main(): Promise<void> {
  const cfg = shopifyConfig()
  const client = new ShopifyClient({ config: cfg })

  console.log('')
  console.log(`Shopify Admin API schema — ${cfg.storeDomain} @ ${cfg.apiVersion}`)
  console.log('═'.repeat(78))

  const shop = await client.graphql<{
    shop: { name: string; myshopifyDomain: string; currencyCode: string; weightUnit: string }
    productsCount: { count: number }
  }>(/* GraphQL */ `
    {
      shop {
        name
        myshopifyDomain
        currencyCode
        weightUnit
      }
      productsCount {
        count
      }
    }
  `)
  console.log(
    `  shop "${shop.shop.name}" · ${shop.shop.myshopifyDomain} · ${shop.shop.currencyCode} · ` +
      `default weight ${shop.shop.weightUnit} · ${shop.productsCount.count} product(s)`,
  )
  console.log('')

  for (const name of TYPES) {
    const data = await client.graphql<IntrospectResponse>(QUERY, { name })
    const type = data.__type
    console.log(`${name}`)
    console.log('─'.repeat(78))
    if (!type) {
      console.log('  DOES NOT EXIST in this API version ⚠')
      console.log('')
      continue
    }
    for (const field of type.inputFields ?? []) {
      console.log(`  ${field.name.padEnd(28)}${renderType(field.type)}`)
    }
    for (const value of type.enumValues ?? []) {
      console.log(`  ${value.name}`)
    }
    console.log('')
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
