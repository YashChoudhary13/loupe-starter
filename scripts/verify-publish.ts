/**
 * Phase 2 · success criteria 1–4, demonstrated against the real Shopify store.
 *
 *   npm run verify:publish                  # publishes, keeps everything (tagged loupe-test)
 *   npm run verify:publish -- --cleanup     # sweeps the noise, KEEPS criterion 1's product
 *   npm run verify:publish -- --cleanup-all # sweeps that too, leaving the store as found
 *
 * `--cleanup` deliberately spares the one product criterion 1 asserted against: its
 * ID is the evidence, and an ID that no longer resolves is not evidence of anything.
 *
 * These four cannot be proved with a mock. Idempotency is a property of Shopify's
 * `productSet`, not of our code; twenty distinct SKUs under load is a property of a
 * Postgres row lock; and "the retry produced ONE product" can only be answered by
 * counting products in the store. So this talks to the store, and every assertion
 * is a READ-BACK — never the mutation's own reply about what it thinks it did.
 *
 *   1. A product publishes with the right title, handle, SKU, tag, product_type,
 *      price, stock, weight and material metafield.
 *   2. IDEMPOTENCY — publishing twice leaves exactly ONE product.
 *   3. CONCURRENCY — 20 parallel publishes, 20 distinct consecutive SKUs,
 *      20 distinct products.
 *   4. FAILURE — a failure between reserving the SKU and productSet succeeding
 *      lands the draft in `failed`, and the retry reuses the SAME handle and
 *      produces one product. Both orderings are covered: the call that never
 *      reached Shopify, and the one that reached it and was never recorded.
 *
 * Everything it creates is tagged `loupe-test`, so it is findable in the admin
 * whether or not it gets cleaned up.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { ShopifyClient, type ShopifyClientOptions } from '../src/lib/shopify/client'
import { shopifyConfig } from '../src/lib/shopify/config'
import { ShopifyError } from '../src/lib/shopify/errors'
import {
  countProductsByHandle,
  deleteProduct,
  readProductByHandle,
  type ProductReadback,
} from '../src/lib/shopify/product-set'
import { paiseToShopifyPrice } from '../src/lib/publish/identity'
import { publishProduct, PRODUCT_TYPE } from '../src/lib/publish/publish-product'
import { PublishBlockedError } from '../src/lib/publish/validate'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const CLEANUP_ALL = process.argv.includes('--cleanup-all')
const CLEANUP = CLEANUP_ALL || process.argv.includes('--cleanup')
const TEST_TAG = 'loupe-test'
const ACTOR = 'script:verify-publish'

let failures = 0
const createdDraftIds: string[] = []
const createdProductIds = new Set<string>()

function required(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) throw new Error(`Missing ${key} in .env`)
  return v
}

const db: SupabaseClient = createClient(
  required('NEXT_PUBLIC_SUPABASE_URL'),
  required('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
)

// ---------------------------------------------------------------------------

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  const shown = typeof actual === 'string' ? actual : JSON.stringify(actual)
  const want = typeof expected === 'string' ? expected : JSON.stringify(expected)
  console.log(
    `  ${ok ? '✓' : '✗'} ${label.padEnd(42)}${shown}${ok ? '' : `   ← expected ${want}`}`,
  )
}

/** Every product carrying the test tag, whichever run created it. */
async function findTestProducts(shopify: ShopifyClient): Promise<string[]> {
  const data = await shopify.graphql<{
    products: { nodes: readonly { id: string }[] }
  }>(
    /* GraphQL */ `
      query LoupeTestProducts($query: String!) {
        products(first: 250, query: $query) {
          nodes {
            id
          }
        }
      }
    `,
    { query: `tag:${TEST_TAG}` },
  )
  return data.products.nodes.map((n) => n.id)
}

function assert(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `   ${detail}` : ''}`)
}

function heading(text: string): void {
  console.log('')
  console.log(text)
  console.log('─'.repeat(78))
}

// ---------------------------------------------------------------------------
// A client that fails a chosen operation, to simulate criterion 4's crash.
// ---------------------------------------------------------------------------

class SabotagedShopifyClient extends ShopifyClient {
  constructor(
    options: ShopifyClientOptions,
    private readonly failWhen: (query: string) => boolean,
  ) {
    super(options)
  }

  override async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (this.failWhen(query)) {
      throw new ShopifyError('simulated failure: the network dropped mid-productSet', {
        kind: 'network',
        retryable: true,
      })
    }
    return super.graphql<T>(query, variables)
  }
}

// ---------------------------------------------------------------------------

interface Fixtures {
  necklaceId: string
  materialId: string
  goldId: string
  silverId: string
}

async function loadFixtures(): Promise<Fixtures> {
  const { data: category } = await db
    .from('categories')
    .select('id')
    .eq('sku_prefix', 'NK')
    .single<{ id: string }>()
  const { data: material } = await db
    .from('materials')
    .select('id')
    .eq('name', '316L')
    .single<{ id: string }>()

  const colourIds: Record<string, string> = {}
  for (const name of ['Gold', 'Silver']) {
    const { data: existing } = await db
      .from('colours')
      .select('id')
      .eq('name', name)
      .maybeSingle<{ id: string }>()
    if (existing) {
      colourIds[name] = existing.id
    } else {
      const { data, error } = await db
        .from('colours')
        .insert({ name })
        .select('id')
        .single<{ id: string }>()
      if (error) throw new Error(`could not create colour ${name}: ${error.message}`)
      colourIds[name] = data.id
    }
  }

  return {
    necklaceId: category!.id,
    materialId: material!.id,
    goldId: colourIds.Gold,
    silverId: colourIds.Silver,
  }
}

async function createDraft(
  f: Fixtures,
  fields: {
    price_paise?: number | null
    stock?: number
    weight_g?: number | null
    title_suffix?: string | null
    colours?: boolean
    material?: boolean
  } = {},
): Promise<string> {
  const { data, error } = await db
    .from('product_drafts')
    .insert({
      category_id: f.necklaceId,
      material_id: fields.material === false ? null : f.materialId,
      price_paise: fields.price_paise === undefined ? 75_000 : fields.price_paise,
      stock: fields.stock ?? 12,
      weight_g: fields.weight_g === undefined ? 28 : fields.weight_g,
      title_suffix: fields.title_suffix ?? null,
      created_by: ACTOR,
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !data) throw new Error(`could not create draft: ${error?.message}`)
  createdDraftIds.push(data.id)

  if (fields.colours) {
    const { error: variantError } = await db.from('product_draft_variants').insert([
      { product_draft_id: data.id, colour_id: f.goldId, position: 0 },
      { product_draft_id: data.id, colour_id: f.silverId, position: 1 },
    ])
    if (variantError) throw new Error(`could not add colours: ${variantError.message}`)
  }

  return data.id
}

async function draftRow(id: string) {
  const { data } = await db
    .from('product_drafts')
    .select('status, reserved_sku, reserved_handle, shopify_product_id, error, published_at')
    .eq('id', id)
    .single<{
      status: string
      reserved_sku: string | null
      reserved_handle: string | null
      shopify_product_id: string | null
      error: string | null
      published_at: string | null
    }>()
  return data!
}

async function eventNames(draftId: string): Promise<string[]> {
  const { data } = await db
    .from('events')
    .select('event')
    .eq('entity_id', draftId)
    .order('id', { ascending: true })
  return (data ?? []).map((e) => e.event as string)
}

async function readCounter(prefix: string): Promise<number> {
  const { data } = await db
    .from('sku_counters')
    .select('last_number')
    .eq('sku_prefix', prefix)
    .single<{ last_number: number }>()
  return data!.last_number
}

function variantSummary(product: ProductReadback) {
  return product.variants.nodes.map((v) => ({
    sku: v.sku,
    price: v.price,
    colour: v.selectedOptions.find((o) => o.name === 'Colour')?.value ?? null,
    stock: v.inventoryQuantity,
    weight: v.inventoryItem?.measurement?.weight
      ? `${v.inventoryItem.measurement.weight.value} ${v.inventoryItem.measurement.weight.unit}`
      : null,
  }))
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = shopifyConfig()
  const shopify = new ShopifyClient({ config: cfg })

  console.log('')
  console.log('verify:publish — Phase 2 success criteria 1–4, against the real store')
  console.log('═'.repeat(78))
  console.log(`  store        ${cfg.storeDomain}`)
  console.log(`  api version  ${cfg.apiVersion}`)
  console.log(`  products     tagged "${TEST_TAG}"${CLEANUP ? ', deleted at the end' : ', kept'}`)

  // ── preflight ─────────────────────────────────────────────────────────────
  heading('PREFLIGHT — the client_credentials grant')
  await shopify.tokens.getToken()
  const stats = shopify.tokens.stats()
  const hours = (ms: number) => (ms / 3_600_000).toFixed(1)
  console.log(`  token minted, ${stats.fetches} fetch(es)`)
  console.log(`  scope        ${stats.scope ?? '(not reported)'}`)
  console.log(
    `  expires in   ${hours(stats.expiresAt! - Date.now())} h · refreshes in ` +
      `${hours(stats.refreshAt! - Date.now())} h`,
  )

  const shop = await shopify.graphql<{
    shop: { name: string; myshopifyDomain: string; currencyCode: string }
  }>('{ shop { name myshopifyDomain currencyCode } }')
  console.log(
    `  shop         "${shop.shop.name}" · ${shop.shop.myshopifyDomain} · ${shop.shop.currencyCode}`,
  )

  const fixtures = await loadFixtures()

  // ── criterion 1 ───────────────────────────────────────────────────────────
  heading('CRITERION 1 — a product publishes with every field correct')

  const draft1 = await createDraft(fixtures, {
    price_paise: 75_000,
    stock: 12,
    weight_g: 28,
    title_suffix: '(Light Rose gold)',
    colours: true,
  })
  const result1 = await publishProduct(db, shopify, draft1, {
    actor: ACTOR,
    extraTags: [TEST_TAG],
  })
  createdProductIds.add(result1.shopifyProductId)

  console.log(`  published    ${result1.sku} · ${result1.title} · ${result1.handle}`)
  console.log(`  SHOPIFY PRODUCT ID   ${result1.shopifyProductId}`)
  console.log('')

  // Read it BACK from Shopify. What productSet claims it did is not evidence.
  const readback = await readProductByHandle(shopify, result1.handle)
  assert('the product exists in the store', readback !== null)
  if (readback) {
    check('id', readback.id, result1.shopifyProductId)
    check('title', readback.title, result1.title)
    check('handle', readback.handle, result1.handle)
    check('product_type', readback.productType, PRODUCT_TYPE)
    check('status', readback.status, 'ACTIVE')
    check('tags', [...readback.tags].sort(), ['Necklace', TEST_TAG].sort())
    check('material metafield', readback.metafield?.value ?? null, '316L')

    const variants = variantSummary(readback)
    console.log(`  variants     ${JSON.stringify(variants, null, 0)}`)
    check('variant count', variants.length, 2)
    check(
      'every variant SHARES the SKU',
      variants.map((v) => v.sku),
      [result1.sku, result1.sku],
    )
    check(
      'colours',
      variants.map((v) => v.colour).sort(),
      ['Gold', 'Silver'],
    )
    check(
      'price',
      variants.map((v) => v.price),
      [paiseToShopifyPrice(75_000), paiseToShopifyPrice(75_000)],
    )
    check(
      'weight',
      variants.map((v) => v.weight),
      ['28 GRAMS', '28 GRAMS'],
    )
    check(
      'stock',
      variants.map((v) => v.stock),
      [12, 12],
    )
  }

  const draft1Row = await draftRow(draft1)
  check('draft status', draft1Row.status, 'published')
  check('draft carries the product id', draft1Row.shopify_product_id, result1.shopifyProductId)
  assert('published_at is set', draft1Row.published_at !== null)
  check('events', await eventNames(draft1), ['publish.reserved', 'publish.published'])

  // ── criterion 2 ───────────────────────────────────────────────────────────
  heading('CRITERION 2 — IDEMPOTENCY: publishing twice leaves exactly one product')

  const counterBeforeRepublish = await readCounter('NK')
  const result2 = await publishProduct(db, shopify, draft1, {
    actor: ACTOR,
    extraTags: [TEST_TAG],
  })

  console.log(`  second call  handle "${result2.handle}"`)
  check('reused the reserved identity', result2.reusedIdentity, true)
  check('same SKU', result2.sku, result1.sku)
  check('same handle', result2.handle, result1.handle)
  check('SAME Shopify product id', result2.shopifyProductId, result1.shopifyProductId)
  check('no SKU number was burnt', await readCounter('NK'), counterBeforeRepublish)

  // THE count query. `productsCount(query: "handle:<handle>")`, straight from Shopify.
  const countAfterTwo = await countProductsByHandle(shopify, result1.handle)
  console.log('')
  console.log(`  count query  productsCount(query: "handle:${result1.handle}")`)
  check('products in the store with this handle', countAfterTwo, 1)

  // ── criterion 3 ───────────────────────────────────────────────────────────
  heading('CRITERION 3 — CONCURRENCY: 20 parallel publishes, 20 distinct SKUs')

  const N = 20
  const counterBefore = await readCounter('NK')
  const tokenFetchesBefore = shopify.tokens.stats().fetches

  const concurrentDrafts = await Promise.all(
    Array.from({ length: N }, () =>
      createDraft(fixtures, { price_paise: 49_900, stock: 3, weight_g: 15 }),
    ),
  )

  const startedAt = Date.now()
  const settled = await Promise.allSettled(
    concurrentDrafts.map((id) =>
      publishProduct(db, shopify, id, { actor: ACTOR, extraTags: [TEST_TAG] }),
    ),
  )
  const elapsed = Date.now() - startedAt

  const succeeded = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
  const rejected = settled.filter((s) => s.status === 'rejected')
  for (const product of succeeded) createdProductIds.add(product.shopifyProductId)

  const skus = succeeded.map((r) => r.sku)
  const numbers = skus
    .map((s) => Number.parseInt(s.replace(/\D/g, ''), 10))
    .sort((a, b) => a - b)
  const counterAfter = await readCounter('NK')

  console.log(`  wall clock   ${elapsed} ms`)
  check('publishes issued', settled.length, N)
  check('publishes succeeded', succeeded.length, N)
  if (rejected.length > 0) {
    for (const r of rejected.slice(0, 5)) {
      console.log(`      ✗ ${(r as PromiseRejectedResult).reason}`)
    }
  }
  check('DISTINCT SKUs', new Set(skus).size, N)
  check('SKUs are consecutive', numbers, Array.from({ length: N }, (_, i) => counterBefore + 1 + i))
  check('counter moved by exactly N', counterAfter - counterBefore, N)
  check('DISTINCT Shopify product ids', new Set(succeeded.map((r) => r.shopifyProductId)).size, N)
  check(
    'token fetches during the burst',
    shopify.tokens.stats().fetches - tokenFetchesBefore,
    0, // already cached — 20 parallel publishes must not mint 20 tokens
  )
  console.log(`  SKU range    ${skus.length ? `${numbers[0]} … ${numbers[numbers.length - 1]}` : '—'}`)

  // Count each handle in Shopify: 20 handles, one product each.
  const counts = await Promise.all(
    succeeded.map((r) => countProductsByHandle(shopify, r.handle)),
  )
  check('every handle maps to exactly one product', [...new Set(counts)], [1])

  // ── criterion 4 ───────────────────────────────────────────────────────────
  heading('CRITERION 4 — FAILURE between reserving the SKU and productSet')

  const draft4 = await createDraft(fixtures, { price_paise: 60_000, stock: 4, weight_g: 22 })
  const saboteur = new SabotagedShopifyClient({ config: cfg, tokens: shopify.tokens }, (q) =>
    q.includes('LoupeProductSet'),
  )

  let sabotagedError: unknown
  try {
    await publishProduct(db, saboteur, draft4, { actor: ACTOR, extraTags: [TEST_TAG] })
  } catch (e) {
    sabotagedError = e
  }

  console.log('  4a — the call never reached Shopify')
  assert('publish threw', sabotagedError instanceof ShopifyError)
  const failedRow = await draftRow(draft4)
  check('draft status', failedRow.status, 'failed')
  assert('the error was recorded', (failedRow.error ?? '').includes('simulated failure'))
  assert('reserved_sku was KEPT', failedRow.reserved_sku !== null, failedRow.reserved_sku ?? '')
  assert('reserved_handle was KEPT', failedRow.reserved_handle !== null, failedRow.reserved_handle ?? '')
  check('nothing was published', failedRow.shopify_product_id, null)
  check(
    'no product exists for that handle',
    await countProductsByHandle(shopify, failedRow.reserved_handle!),
    0,
  )
  check('events', await eventNames(draft4), ['publish.reserved', 'publish.failed'])

  console.log('')
  console.log('  4a — the retry')
  const counterBeforeRetry = await readCounter('NK')
  const retry = await publishProduct(db, shopify, draft4, { actor: ACTOR, extraTags: [TEST_TAG] })
  createdProductIds.add(retry.shopifyProductId)

  check('retry reused the SAME handle', retry.handle, failedRow.reserved_handle)
  check('retry reused the SAME SKU', retry.sku, failedRow.reserved_sku)
  check('the retry burnt no new number', await readCounter('NK'), counterBeforeRetry)
  check('exactly ONE product exists', await countProductsByHandle(shopify, retry.handle), 1)
  check('draft status', (await draftRow(draft4)).status, 'published')

  console.log('')
  console.log('  4b — the nastier ordering: Shopify succeeded, we never recorded it')
  // This is the case that actually creates duplicate products in the wild — a
  // crash after productSet returned but before the draft was marked published.
  // Simulated by marking the (really published) draft failed and republishing.
  const { error: markError } = await db.rpc('mark_draft_failed', {
    p_draft_id: draft4,
    p_error: 'simulated crash after productSet returned, before it was recorded',
    p_retryable: true,
    p_actor: ACTOR,
  })
  if (markError) throw new Error(markError.message)

  const recovery = await publishProduct(db, shopify, draft4, { actor: ACTOR, extraTags: [TEST_TAG] })
  check('recovery hit the same handle', recovery.handle, retry.handle)
  check('recovery hit the same product id', recovery.shopifyProductId, retry.shopifyProductId)
  check('STILL exactly one product', await countProductsByHandle(shopify, retry.handle), 1)

  // ── criterion 6, against the real path ────────────────────────────────────
  heading('CRITERION 6 — publish is blocked, end to end, and burns no SKU number')

  const counterBeforeBlocked = await readCounter('NK')

  // A ZERO price cannot even be stored: product_drafts_price_paise_check is
  // `price_paise is null or price_paise > 0`. So the strongest available assertion
  // is not "publish blocks it" but "the database will not hold it". validate.ts
  // blocks it too, for the case where a draft somehow arrives with one —
  // tests/publish-validation.test.ts covers that path.
  const zeroPriceInsert = await db.from('product_drafts').insert({
    category_id: fixtures.necklaceId,
    material_id: fixtures.materialId,
    price_paise: 0,
    stock: 12,
    weight_g: 28,
    created_by: ACTOR,
  })
  assert(
    'a zero price is not even STORABLE'.padEnd(28),
    (zeroPriceInsert.error?.message ?? '').includes('price_paise'),
    `[${zeroPriceInsert.error?.code ?? 'no error'}]`,
  )

  const noPrice = await createDraft(fixtures, { price_paise: null })
  const zeroStock = await createDraft(fixtures, { stock: 0 })

  for (const [label, id, options] of [
    ['empty price', noPrice, {}],
    ['zero stock', zeroStock, {}],
  ] as const) {
    let blocked: unknown
    try {
      await publishProduct(db, shopify, id, { actor: ACTOR, ...options })
    } catch (e) {
      blocked = e
    }
    const codes =
      blocked instanceof PublishBlockedError ? blocked.blocks.map((b) => b.code).join(', ') : '—'
    assert(`${label} is blocked`.padEnd(28), blocked instanceof PublishBlockedError, `[${codes}]`)
    check(`  …and reserves nothing`, (await draftRow(id)).reserved_sku, null)
  }

  // The override, on the same draft that was just blocked.
  const overridden = await publishProduct(db, shopify, zeroStock, {
    actor: ACTOR,
    allowZeroStock: true,
    extraTags: [TEST_TAG],
  })
  createdProductIds.add(overridden.shopifyProductId)
  assert('zero stock publishes when explicitly overridden', true, overridden.sku)
  check(
    'only the override burnt a number',
    await readCounter('NK'),
    counterBeforeBlocked + 1,
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  heading('CLEANUP')
  console.log(`  ${createdProductIds.size} product(s) created this run, all tagged "${TEST_TAG}"`)
  if (CLEANUP) {
    // Sweeps EVERY loupe-test product and EVERY draft this script has ever made,
    // not just this run's. A failed run leaves debris behind, and debris that only
    // the run which created it can remove is debris forever.
    const stale = await findTestProducts(shopify)
    const doomed = new Set([...createdProductIds, ...stale])
    // Criterion 1's product is the evidence. Keep it unless asked otherwise.
    if (!CLEANUP_ALL) doomed.delete(result1.shopifyProductId)

    let deleted = 0
    for (const id of doomed) {
      await deleteProduct(shopify, id)
      deleted += 1
    }
    console.log(`  deleted ${deleted} Shopify product(s) tagged "${TEST_TAG}"`)
    if (!CLEANUP_ALL) {
      console.log(`  KEPT criterion 1's product   ${result1.shopifyProductId}`)
      console.log(`       ${result1.sku} · ${result1.title} · /products/${result1.handle}`)
    }

    const { data: allDrafts } = await db
      .from('product_drafts')
      .select('id')
      .eq('created_by', ACTOR)
    const draftIds = (allDrafts ?? [])
      .map((d) => d.id as string)
      .filter((id) => CLEANUP_ALL || id !== draft1)
    if (draftIds.length > 0) {
      await db.from('events').delete().in('entity_id', draftIds)
      await db.from('product_draft_variants').delete().in('product_draft_id', draftIds)
      await db.from('product_drafts').delete().in('id', draftIds)
    }
    console.log(`  deleted ${draftIds.length} draft(s) and their events`)
    console.log('')
    console.log('  SKU counters were deliberately NOT reset. Gaps in a sequence are')
    console.log('  expected and harmless; lowering a counter is the thing that produces')
    console.log('  a second RS221, and nothing in this project is allowed to do it.')
  } else {
    console.log(`  kept. Find them in the admin with the search  tag:${TEST_TAG}`)
    console.log('  Re-run with `npm run verify:publish -- --cleanup` to delete them.')
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log('')
  console.log('═'.repeat(78))
  if (failures === 0) {
    console.log('✓ Every assertion passed.')
  } else {
    console.log(`✗ ${failures} assertion(s) FAILED.`)
  }
  console.log('')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('')
  console.error(`✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error('')
  if (createdDraftIds.length > 0 || createdProductIds.size > 0) {
    console.error(
      `  Left behind: ${createdProductIds.size} Shopify product(s) tagged "${TEST_TAG}" and ` +
        `${createdDraftIds.length} draft(s).`,
    )
  }
  process.exit(1)
})
