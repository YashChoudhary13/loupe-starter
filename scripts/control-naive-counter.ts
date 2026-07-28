/**
 * Control experiment for the SKU concurrency test.
 *
 * Runs the SAME 100-way concurrent load against both implementations:
 *
 *   public.next_sku()              — one UPDATE ... RETURNING   (shipped)
 *   public._loupe_naive_next_sku() — SELECT, then UPDATE        (broken, fixture)
 *
 * Requires the fixture from tests/fixtures/naive-counter.sql to be loaded, and
 * skips with an explanation if it is not.
 *
 * A test that passes but would also pass against a broken implementation is not
 * evidence. This is how we know it is.
 */
import { config } from 'dotenv'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const PREFIX = 'NK'
const CALLS = 100

async function call(fn: string): Promise<number | null> {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_prefix: PREFIX }),
  })
  return res.ok ? ((await res.json()) as number) : null
}

async function counter(): Promise<number> {
  const res = await fetch(
    `${URL_}/rest/v1/sku_counters?sku_prefix=eq.${PREFIX}&select=last_number`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  )
  return ((await res.json()) as { last_number: number }[])[0].last_number
}

async function setCounter(v: number): Promise<void> {
  await fetch(`${URL_}/rest/v1/sku_counters?sku_prefix=eq.${PREFIX}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_number: v }),
  })
}

async function trial(fn: string, label: string): Promise<void> {
  const start = await counter()
  const t0 = performance.now()
  const results = (await Promise.all(Array.from({ length: CALLS }, () => call(fn)))).filter(
    (v): v is number => v !== null,
  )
  const ms = performance.now() - t0
  const after = await counter()

  const distinct = new Set(results)
  const dupes = [...distinct].filter((v) => results.filter((r) => r === v).length > 1)
  const expected = Array.from({ length: CALLS }, (_, i) => start + i + 1)
  const missing = expected.filter((v) => !distinct.has(v))

  console.log(`\n${label}`)
  console.log(`${'─'.repeat(label.length)}`)
  console.log(`  returned            ${results.length} value(s) in ${ms.toFixed(0)} ms`)
  console.log(`  distinct            ${distinct.size} / ${CALLS}`)
  console.log(`  DUPLICATED numbers  ${dupes.length === 0 ? 'none' : `${dupes.length} → ${dupes.slice(0, 12).join(', ')}${dupes.length > 12 ? ' …' : ''}`}`)
  console.log(`  counter             ${start} → ${after}  (expected ${start + CALLS})`)
  console.log(`  numbers never issued ${missing.length}`)
  console.log(
    `  VERDICT             ${distinct.size === CALLS && after === start + CALLS ? 'SAFE — every product would get a unique SKU' : 'BROKEN — this is how two products end up on RS221'}`,
  )

  await setCounter(start)
}

async function main(): Promise<void> {
  const baseline = await counter()

  await trial('next_sku', 'SHIPPED  public.next_sku()  —  single UPDATE ... RETURNING')

  const probe = await fetch(`${URL_}/rest/v1/rpc/_loupe_naive_next_sku`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_prefix: PREFIX }),
  })
  if (probe.status === 404) {
    console.log('\nFixture _loupe_naive_next_sku is not loaded — skipping the broken-control half.')
    console.log('Load tests/fixtures/naive-counter.sql to run the comparison.\n')
    await setCounter(baseline)
    return
  }
  await setCounter(baseline)

  await trial(
    '_loupe_naive_next_sku',
    'CONTROL  public._loupe_naive_next_sku()  —  SELECT then UPDATE',
  )

  await setCounter(baseline)
  console.log(`\nCounter restored to ${await counter()}.\n`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exit(1)
})
