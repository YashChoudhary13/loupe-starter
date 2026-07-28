/**
 * Seeds `sku_counters.last_number` from the TRUE MAX per prefix in Shopify.
 *
 *   npm run seed:counters -- --dry-run     # prints what it would do, changes nothing
 *   npm run seed:counters                  # applies it
 *
 * WHY THIS EXISTS
 *
 *   Loupe's counters start at 0. The store's sequences do not — a human maintained
 *   them by hand for 1,600 products. Publish before seeding and the first necklace
 *   goes out as NK001, on top of a necklace that already exists.
 *
 * WHY THIS IS NOT A VIOLATION OF docs/DECISIONS.md D2
 *
 *   D2 forbids deriving a SKU number from Shopify **at publish time**, because
 *   drafts, deletions and in-flight writes make a "current max" query lie, and
 *   Shopify accepts a duplicate SKU silently. That is how RS221 ended up on two
 *   products. All of it remains true.
 *
 *   This is the opposite situation: a deliberate one-time seeding operation, run
 *   with the store quiet, to establish where the hand-maintained sequence had got
 *   to. It runs at setup and again at cutover to the live store — not on any
 *   publish path. D2 was extended with a section spelling this out, so a future
 *   session does not "fix" this script by deleting it.
 *
 *   The safety property is structural, not a promise: the write goes through
 *   `public.raise_sku_counter()`, a single `UPDATE … SET last_number =
 *   greatest(last_number, p_to)`. It is MONOTONE — it can raise a counter and can
 *   never lower one. So it is idempotent, safe to re-run, and safe to run against a
 *   store that has been published to since. The worst a stale read can do is nothing.
 *
 * A prefix found in Shopify but absent from `categories` is REPORTED, never
 * created. Inventing a prefix starts a sequence nobody can reconcile, and the
 * eight unconfirmed categories (Watches, Hand Chains, …) are unconfirmed
 * precisely because nobody has read their real prefix off a live product.
 *
 * SANITY CHECK AT CUTOVER — the live store's maxima, as of Phase 2, are
 * NK 970 · ER 453 · BK 317 · CB 352 · RS 224 · AK 087. They are written here as
 * prose on purpose: the script must derive its numbers, never carry them. Against
 * the `qimti` TEST store this run is expected to find almost nothing.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { ShopifyClient } from '../src/lib/shopify/client'
import { shopifyConfig } from '../src/lib/shopify/config'
import { ShopifyError } from '../src/lib/shopify/errors'
import { parseSku } from '../src/lib/publish/identity'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const DRY_RUN = process.argv.includes('--dry-run')

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
          id
          title
        }
      }
    }
  }
`

interface VariantPage {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: readonly { sku: string | null; product: { id: string; title: string } | null }[]
  }
}

interface PrefixFinding {
  prefix: string
  max: number
  count: number
  exampleSku: string
  exampleTitle: string
}

function required(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) throw new Error(`Missing ${key} in .env`)
  return v
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

/** Walks every variant in the store. Variants carry the SKU; products do not. */
async function collectSkus(shopify: ShopifyClient): Promise<{
  findings: Map<string, PrefixFinding>
  scanned: number
  blank: number
  unparseable: { sku: string; title: string }[]
}> {
  const findings = new Map<string, PrefixFinding>()
  const unparseable: { sku: string; title: string }[] = []
  let cursor: string | null = null
  let scanned = 0
  let blank = 0
  let page = 0

  for (;;) {
    const data: VariantPage = await shopify.graphql<VariantPage>(ALL_VARIANT_SKUS, { cursor })
    page += 1

    for (const node of data.productVariants.nodes) {
      scanned += 1
      const sku = node.sku?.trim() ?? ''
      if (sku === '') {
        blank += 1
        continue
      }

      const parsed = parseSku(sku)
      if (!parsed) {
        if (unparseable.length < 25) {
          unparseable.push({ sku, title: node.product?.title ?? '(no product)' })
        }
        continue
      }

      const existing = findings.get(parsed.prefix)
      if (!existing) {
        findings.set(parsed.prefix, {
          prefix: parsed.prefix,
          max: parsed.number,
          count: 1,
          exampleSku: sku,
          exampleTitle: node.product?.title ?? '',
        })
      } else {
        existing.count += 1
        if (parsed.number > existing.max) {
          existing.max = parsed.number
          existing.exampleSku = sku
          existing.exampleTitle = node.product?.title ?? ''
        }
      }
    }

    process.stdout.write(`\r  page ${page} · ${scanned} variants scanned`)
    if (!data.productVariants.pageInfo.hasNextPage) break
    cursor = data.productVariants.pageInfo.endCursor
    if (!cursor) break
  }

  process.stdout.write('\n')
  return { findings, scanned, blank, unparseable }
}

async function main(): Promise<void> {
  const db: SupabaseClient = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const cfg = shopifyConfig()
  const shopify = new ShopifyClient({ config: cfg })

  console.log('')
  console.log('seed:counters — set sku_counters.last_number to the true max per prefix')
  console.log('─'.repeat(78))
  console.log(`  store        ${cfg.storeDomain}`)
  console.log(`  api version  ${cfg.apiVersion}`)
  console.log(`  mode         ${DRY_RUN ? 'DRY RUN — nothing will be written' : 'APPLY'}`)
  console.log('')

  const { data: categories, error: catError } = await db
    .from('categories')
    .select('name, sku_prefix')
    .order('sort_order', { ascending: true })
  if (catError) throw new Error(`Could not read categories: ${catError.message}`)

  const { data: counters, error: counterError } = await db
    .from('sku_counters')
    .select('sku_prefix, last_number')
  if (counterError) throw new Error(`Could not read sku_counters: ${counterError.message}`)

  const categoryByPrefix = new Map((categories ?? []).map((c) => [c.sku_prefix as string, c.name as string]))
  const counterByPrefix = new Map(
    (counters ?? []).map((c) => [c.sku_prefix as string, c.last_number as number]),
  )

  console.log('Reading every variant from Shopify …')
  const { findings, scanned, blank, unparseable } = await collectSkus(shopify)
  console.log(
    `  ${scanned} variants · ${findings.size} distinct SKU prefix(es) · ` +
      `${blank} blank SKU(s) · ${unparseable.length} unparseable`,
  )
  console.log('')

  // ---------------------------------------------------------------------------
  console.log('KNOWN PREFIXES — the ones in `categories`')
  console.log('─'.repeat(78))
  console.log(
    `  ${pad('prefix', 8)}${pad('category', 20)}${padLeft('counter', 9)}${padLeft('shopify max', 13)}   action`,
  )

  const toRaise: { prefix: string; from: number; to: number }[] = []

  for (const [prefix, name] of categoryByPrefix) {
    const current = counterByPrefix.get(prefix) ?? 0
    const found = findings.get(prefix)
    const max = found?.max ?? 0

    let action: string
    if (!found) {
      action = 'nothing in Shopify — leave at ' + current
    } else if (max > current) {
      action = `RAISE ${current} → ${max}   (${found.exampleSku} "${found.exampleTitle}")`
      toRaise.push({ prefix, from: current, to: max })
    } else if (max === current) {
      action = 'already correct'
    } else {
      action = `counter is AHEAD of Shopify by ${current - max} — left alone (never lower)`
    }

    console.log(
      `  ${pad(prefix, 8)}${pad(name, 20)}${padLeft(String(current), 9)}${padLeft(found ? String(max) : '—', 13)}   ${action}`,
    )
  }
  console.log('')

  // ---------------------------------------------------------------------------
  const unknown = [...findings.values()].filter((f) => !categoryByPrefix.has(f.prefix))
  console.log('UNKNOWN PREFIXES — present in Shopify, absent from `categories`')
  console.log('─'.repeat(78))
  if (unknown.length === 0) {
    console.log('  none')
  } else {
    for (const f of unknown.sort((a, b) => b.count - a.count)) {
      console.log(
        `  ${pad(f.prefix, 8)}${padLeft(String(f.count), 6)} variant(s), max ${padLeft(String(f.max), 5)}   ` +
          `e.g. ${f.exampleSku} "${f.exampleTitle}"`,
      )
    }
    console.log('')
    console.log('  NOT created. A prefix is only real once someone has confirmed its category,')
    console.log('  title pattern and exact Shopify tag against a live product. Inventing one')
    console.log('  starts a sequence that has to be unpicked later.')
  }
  console.log('')

  if (unparseable.length > 0) {
    console.log('UNPARSEABLE SKUs — not <letters><digits>, so no prefix could be read')
    console.log('─'.repeat(78))
    for (const u of unparseable.slice(0, 15)) console.log(`  ${pad(u.sku, 24)} "${u.title}"`)
    if (unparseable.length > 15) console.log(`  … and ${unparseable.length - 15} more`)
    console.log('')
  }

  // ---------------------------------------------------------------------------
  if (DRY_RUN) {
    console.log('DRY RUN — nothing was written.')
    console.log(
      toRaise.length === 0
        ? '  No counter would change.\n'
        : `  ${toRaise.length} counter(s) would be raised: ` +
            toRaise.map((r) => `${r.prefix} ${r.from}→${r.to}`).join(', ') +
            '\n',
    )
    return
  }

  console.log('APPLYING')
  console.log('─'.repeat(78))
  if (toRaise.length === 0) {
    console.log('  Nothing to do — every counter is already at or above the Shopify max.')
  }

  const applied: { prefix: string; from: number; to: number; result: number }[] = []
  for (const raise of toRaise) {
    const { data, error } = await db.rpc('raise_sku_counter', {
      p_prefix: raise.prefix,
      p_to: raise.to,
    })
    if (error) throw new Error(`raise_sku_counter(${raise.prefix}, ${raise.to}): ${error.message}`)
    const result = data as number
    applied.push({ ...raise, result })
    console.log(
      `  ${pad(raise.prefix, 8)}${raise.from} → ${result}` +
        (result === raise.to ? '  ✓' : `  ⚠ expected ${raise.to}`),
    )
  }

  // Re-read, so the report is what the database says rather than what we hoped.
  const { data: after, error: afterError } = await db
    .from('sku_counters')
    .select('sku_prefix, last_number')
    .order('sku_prefix', { ascending: true })
  if (afterError) throw new Error(`Could not re-read sku_counters: ${afterError.message}`)

  console.log('')
  console.log('COUNTERS NOW')
  console.log('─'.repeat(78))
  for (const row of after ?? []) {
    console.log(`  ${pad(row.sku_prefix as string, 8)}${padLeft(String(row.last_number), 6)}`)
  }

  const { error: eventError } = await db.from('events').insert({
    entity_type: 'system',
    event: 'seed.sku_counters',
    detail: {
      store: cfg.storeDomain,
      variants_scanned: scanned,
      raised: applied,
      unknown_prefixes: unknown.map((u) => ({ prefix: u.prefix, max: u.max, count: u.count })),
      blank_skus: blank,
      unparseable_skus: unparseable.length,
    },
    actor: 'script:seed-counters',
  })
  if (eventError) throw new Error(`Could not write the audit event: ${eventError.message}`)

  console.log('')
  console.log(`✓ Done. ${applied.length} counter(s) raised, audit row written to events.`)
  console.log('')
}

main().catch((error: unknown) => {
  if (error instanceof ShopifyError) {
    console.error(`\n✗ ${error.message}\n`)
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exit(1)
})
