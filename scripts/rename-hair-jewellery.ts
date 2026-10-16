/**
 * D155 — rename the hair category's Shopify products from Hairband / HA to
 * Hair Jewellery / HJ, in step with migration 20261017100000.
 *
 *   npx tsx scripts/rename-hair-jewellery.ts                 # dry run: prints every change
 *   npx tsx scripts/rename-hair-jewellery.ts --apply         # writes, reads back, saves a receipt
 *   npx tsx scripts/rename-hair-jewellery.ts --undo <receipt.json>
 *
 * Loupe drafts (HA013–HA029): title from the category pattern, handle = Loupe's
 * reserved handle, SKU and barcode = the reserved SKU, SEO from buildSeo. The
 * daily reconciliation reads each draft by its Loupe handle and deletes the
 * draft when nothing answers, so --apply refuses to run until the migration
 * has applied and both sides can change in the same sitting.
 *
 * Legacy products without a Loupe draft (HA001, HA012): title noun, SKU and
 * SEO noun only — their handles stay, so no redirects are needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { config } from 'dotenv'

import { buildSeo } from '../src/lib/publish/seo'
import { parseSku, renderTitle, slugifyHandle } from '../src/lib/publish/identity'
import { ShopifyClient } from '../src/lib/shopify/client'
import { pgClient } from './lib/pg'

config({ path: '.env', quiet: true })

interface Variant { id: string; sku: string | null; barcode: string | null }
interface Snapshot {
  title: string
  handle: string
  seo: { title: string | null; description: string | null }
  variants: Variant[]
}
interface Change { id: string; status: string; source: 'draft' | 'legacy'; before: Snapshot; after: Snapshot }

const PRODUCT_FIELDS = `id status title handle seo { title description } variants(first: 20) { nodes { id sku barcode } }`
const READ_BY_ID = /* GraphQL */ `query RenameHairRead($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`
const SEARCH_HA = /* GraphQL */ `query RenameHairSearch { products(first: 100, query: "sku:HA*") { nodes { ${PRODUCT_FIELDS} } } }`
const BY_HANDLE = /* GraphQL */ `query RenameHairHandle($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { id } }`
const UPDATE_PRODUCT = /* GraphQL */ `
  mutation RenameHairProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id } userErrors { field message } }
  }`
const UPDATE_VARIANTS = /* GraphQL */ `
  mutation RenameHairVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
  }`

type Product = { id: string; status: string } & Omit<Snapshot, 'variants'> & { variants: { nodes: Variant[] } }
const snapshot = (p: Product): Snapshot => ({ title: p.title, handle: p.handle, seo: { ...p.seo }, variants: p.variants.nodes.map((v) => ({ ...v })) })
const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b)

interface DraftRow {
  reserved_sku: string; reserved_handle: string; title_suffix: string | null; shopify_product_id: string
  variant_kind: string; sku_scheme: string; custom_material: string | null; material: string | null
  category: string; title_pattern: string; sku_prefix: string
}

async function plan(shopify: ShopifyClient): Promise<{ changes: Change[]; migrated: boolean }> {
  const db = pgClient()
  await db.connect()
  let rows: DraftRow[]
  try {
    const r = await db.query<DraftRow>(`
      select d.reserved_sku, d.reserved_handle, d.title_suffix, d.shopify_product_id, d.variant_kind, d.sku_scheme,
             d.custom_material, m.name as material, c.name as category, c.title_pattern, c.sku_prefix
        from public.product_drafts d
        join public.categories c on c.id = d.category_id
        left join public.materials m on m.id = d.material_id
       where c.sku_prefix in ('HA', 'HJ') and d.reserved_sku is not null and d.shopify_product_id is not null
       order by d.reserved_sku`)
    rows = r.rows
  } finally {
    await db.end()
  }
  const migrated = rows.length > 0 && rows.every((r) => r.sku_prefix === 'HJ')
  const changes: Change[] = []
  const draftIds = new Set<string>()

  for (const row of rows) {
    draftIds.add(row.shopify_product_id)
    const sku = migrated ? row.reserved_sku : `HJ${row.reserved_sku.slice(2)}`
    const handle = migrated ? row.reserved_handle : row.reserved_handle.replace(/^hairband-/, 'hair-jewellery-')
    const pattern = migrated ? row.title_pattern : 'Hair Jewellery {n}'
    const parsed = parseSku(sku)
    if (!parsed) throw new Error(`${row.reserved_sku}: SKU does not parse`)
    if (row.variant_kind !== 'none') throw new Error(`${row.reserved_sku}: has variants (${row.variant_kind}); extend the script before renaming it`)
    const title = renderTitle(pattern, parsed.number, row.title_suffix)
    if (handle !== slugifyHandle(title)) console.warn(`  note: ${sku} keeps Loupe's frozen handle ${handle} (title would slug to ${slugifyHandle(title)})`)
    const { product } = await shopify.graphql<{ product: Product | null }>(READ_BY_ID, { id: row.shopify_product_id })
    if (!product) throw new Error(`${row.reserved_sku}: Shopify product ${row.shopify_product_id} not found`)
    if (product.variants.nodes.length !== 1) throw new Error(`${row.reserved_sku}: expected one variant, Shopify has ${product.variants.nodes.length}`)
    const before = snapshot(product)
    const seo = buildSeo({ skuPrefix: 'HJ', skuNumber: parsed.number, material: row.custom_material ?? row.material, categoryName: migrated ? row.category : 'Hair Jewellery' })
    const after: Snapshot = {
      title, handle, seo: { title: seo.title, description: seo.description },
      variants: [{ id: before.variants[0]!.id, sku, barcode: row.sku_scheme === 'variant-v1' ? sku : before.variants[0]!.barcode }],
    }
    changes.push({ id: product.id, status: product.status, source: 'draft', before, after })
  }

  const { products } = await shopify.graphql<{ products: { nodes: Product[] } }>(SEARCH_HA)
  for (const product of products.nodes) {
    if (draftIds.has(product.id)) continue
    const before = snapshot(product)
    const noun = (s: string | null) => s === null ? null : s.replace(/Hairband|Hair Accessory/g, 'Hair Jewellery').replace(/hairband|hair accessory/g, 'hair jewellery')
    const after: Snapshot = {
      title: product.title.replace(/^(Hairband|Hair Accessory)\s+(\d+)/i, 'Hair Jewellery $2'),
      handle: product.handle,
      seo: { title: noun(product.seo.title), description: noun(product.seo.description) },
      variants: before.variants.map((v) => {
        const sku = v.sku?.replace(/^HA(\d+)/, 'HJ$1') ?? null
        return { id: v.id, sku, barcode: v.barcode === v.sku ? sku : v.barcode }
      }),
    }
    if (!/^Hair Jewellery \d+/.test(after.title)) console.warn(`  note: ${product.handle} title "${product.title}" was not renamed (pattern not recognised)`)
    changes.push({ id: product.id, status: product.status, source: 'legacy', before, after })
  }
  return { changes, migrated }
}

function print(changes: Change[]) {
  const diff = (a: string | null, b: string | null) => (a === b ? a ?? '—' : `${a ?? '—'}  →  ${b ?? '—'}`)
  for (const c of changes) {
    const skus = c.before.variants.map((v, i) => diff(v.sku, c.after.variants[i]!.sku)).join(', ')
    const barcodes = c.before.variants.map((v, i) => diff(v.barcode, c.after.variants[i]!.barcode)).join(', ')
    console.log(`${c.status.slice(0, 3)} ${c.source.padEnd(6)} ${diff(c.before.title, c.after.title)}`)
    console.log(`           handle  ${diff(c.before.handle, c.after.handle)}`)
    console.log(`           sku     ${skus}   barcode ${barcodes}`)
    console.log(`           seo     ${diff(c.before.seo.title, c.after.seo.title)}`)
    if (c.before.seo.description !== c.after.seo.description) console.log(`                   ${diff(c.before.seo.description, c.after.seo.description)}`)
  }
  console.log(`\n${changes.length} products, ${changes.filter((c) => !same(c.before, c.after)).length} with changes`)
}

async function write(shopify: ShopifyClient, id: string, target: Snapshot) {
  const p = await shopify.graphql<{ productUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(UPDATE_PRODUCT, {
    product: { id, title: target.title, handle: target.handle, seo: { title: target.seo.title, description: target.seo.description } },
  })
  if (p.productUpdate.userErrors.length) throw new Error(`${id} productUpdate: ${p.productUpdate.userErrors.map((e) => e.message).join('; ')}`)
  const v = await shopify.graphql<{ productVariantsBulkUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(UPDATE_VARIANTS, {
    productId: id,
    variants: target.variants.map((variant) => ({ id: variant.id, barcode: variant.barcode, inventoryItem: { sku: variant.sku } })),
  })
  if (v.productVariantsBulkUpdate.userErrors.length) throw new Error(`${id} variants: ${v.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ')}`)
}

async function verify(shopify: ShopifyClient, changes: { id: string; source: string; after: Snapshot }[]) {
  let bad = 0
  for (const c of changes) {
    const { product } = await shopify.graphql<{ product: Product | null }>(READ_BY_ID, { id: c.id })
    if (!product || !same(snapshot(product), c.after)) { bad += 1; console.error(`  MISMATCH after write: ${c.id}`, product && snapshot(product)) ; continue }
    if (c.source === 'draft') {
      const r = await shopify.graphql<{ productByIdentifier: { id: string } | null }>(BY_HANDLE, { handle: c.after.handle })
      if (r.productByIdentifier?.id !== c.id) { bad += 1; console.error(`  handle ${c.after.handle} does not resolve to ${c.id}`) }
    }
  }
  console.log(bad === 0 ? `read back: all ${changes.length} match, every draft handle resolves` : `read back: ${bad} problems`)
  if (bad) process.exit(1)
}

async function main() {
  const mode = process.argv[2] ?? '--dry-run'
  const shopify = new ShopifyClient()
  const receiptDir = join(homedir(), 'Downloads', 'hair-jewellery-2026-10-17')

  if (mode === '--undo') {
    const receipt = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as { changes: Change[] }
    for (const c of receipt.changes) await write(shopify, c.id, c.before)
    await verify(shopify, receipt.changes.map((c) => ({ id: c.id, source: 'legacy', after: c.before })))
    console.log(`undone ${receipt.changes.length} products from ${process.argv[3]}`)
    return
  }

  const { changes, migrated } = await plan(shopify)
  print(changes)
  const pending = changes.filter((c) => !same(c.before, c.after))
  if (mode !== '--apply') {
    console.log(migrated ? '\nMigration applied; run with --apply to write.' : '\nDry run from the pre-migration rows. Run `npm run db:push` first, then --apply.')
    return
  }
  if (!migrated) throw new Error('Refusing to write: migration 20261017100000 has not applied (Loupe still says HA). Run `npm run db:push` first.')
  mkdirSync(receiptDir, { recursive: true })
  const receipt = join(receiptDir, `receipt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(receipt, JSON.stringify({ at: new Date().toISOString(), changes: pending }, null, 2))
  console.log(`\nreceipt ${receipt}`)
  for (const c of pending) { await write(shopify, c.id, c.after); console.log(`  wrote ${c.after.variants[0]?.sku ?? c.id}`) }
  await verify(shopify, pending)
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
