import { config } from 'dotenv'
config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })
import { ShopifyClient } from '../src/lib/shopify/client'
async function main() {
  const shopify = new ShopifyClient()
  const data = await shopify.graphql<any>(`{
    products(first: 250, query: "tag:anklets status:active") {
      nodes { id variants(first:1){nodes{sku}} media(first: 50) { nodes { id alt } } }
    }
  }`)
  let moved = 0
  for (const p of data.products.nodes) {
    const sku = p.variants.nodes[0]?.sku ?? '?'
    const nodes = p.media.nodes
    const wornIndex = nodes.findIndex((m: any) => m.alt?.startsWith('Worn view'))
    if (wornIndex <= 0) continue // none, or already first
    const res = await shopify.graphql<any>(
      `mutation ($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) { mediaUserErrors { message } }
      }`,
      { id: p.id, moves: [{ id: nodes[wornIndex].id, newPosition: '0' }] },
    )
    const errs = res.productReorderMedia.mediaUserErrors
    if (errs.length) { console.error(`FAIL ${sku}: ${errs[0].message}`); continue }
    moved += 1
    console.log(`main ${sku}`)
  }
  console.log(`${moved} product(s) reordered`)
}
main().catch((e) => { console.error(e); process.exit(1) })
