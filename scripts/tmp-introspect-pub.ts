import { config } from 'dotenv'
import { ShopifyClient } from '../src/lib/shopify/client'
import { shopifyConfig } from '../src/lib/shopify/config'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const client = new ShopifyClient(shopifyConfig())

async function main() {
  const s = await client.graphql<any>(
    `query { currentAppInstallation { accessScopes { handle } } }`,
  )
  const scopes = s.currentAppInstallation.accessScopes.map((a: any) => a.handle).sort()
  console.log('granted scopes:\n  ' + scopes.join('\n  '))
  console.log('\nread_publications:', scopes.includes('read_publications'))
  console.log('write_publications:', scopes.includes('write_publications'))

  const d = await client.graphql<any>(`
    query {
      publications(first: 50, catalogType: APP) {
        nodes { id catalog { __typename ... on AppCatalog { title status apps(first:1){nodes{title}} } } }
      }
    }
  `)
  console.log('\nAPP publications:')
  for (const p of d.publications.nodes) {
    console.log(`  ${p.catalog?.title}  [${p.catalog?.status}]  ${p.id}`)
  }
}
main().catch((e) => { console.error(e.message); process.exit(1) })
