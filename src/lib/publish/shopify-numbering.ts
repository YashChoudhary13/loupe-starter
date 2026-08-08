/**
 * Keep Loupe's SKU counter clear of numbers Shopify already uses.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Qimati lists products directly in Shopify admin, often, without the console.
 * Loupe's counter only learns about those during reconciliation — nightly at
 * 03:00 IST or when somebody clicks Full reconciliation. Anything created by
 * hand between scans is invisible to it.
 *
 * Measured 2026-08-08: `necklace-1007` was created by hand at 08:01:39; the next
 * console draft at 08:42:42 was issued `NK1007` from a counter that still said
 * 1006, and `productSet` — which addresses BY HANDLE — collided with the manual
 * product. The scan that would have caught it did not run in that 41-minute
 * window, and by the time it did (08:46) Loupe had already taken 1007 itself, so
 * there was nothing left to raise.
 *
 * WHY NOT JUST "QUERY THE MAX"
 *
 * Hard rule 1 forbids deriving a SKU from Shopify's current max: Shopify accepts
 * duplicate SKUs silently, and drafts, deletions and in-flight writes make any
 * max query lie under concurrency. That rule stands. This does something
 * narrower and monotone — it only ever RAISES the counter past numbers Shopify
 * demonstrably occupies. The counter remains the sole source of the number
 * actually issued; Shopify is consulted only to rule candidates out.
 *
 * WHY PROBE INSTEAD OF SCANNING
 *
 * `sync-sku-counters` pages through every variant SKU in the store. That is
 * right for a nightly audit and far too heavy for a control that must run on
 * every publish. Probing one candidate is two indexed lookups, ~450 ms, in a
 * single request — and normally the first candidate is free, so it costs one
 * round trip.
 *
 * Both a SKU probe and a HANDLE probe are needed, and neither is redundant:
 *
 *   SKU only     misses a hand-made product listed with a blank SKU, which is
 *                common; its handle would still collide, and `productSet` would
 *                then overwrite it.
 *   handle only  misses a product whose title was edited after creation, since
 *                Shopify keeps the original handle while the SKU stays ours.
 *
 * Verified against the live store: `sku:` search is exact, not a prefix match
 * (`sku:NK100` returns NK100 and not NK1007), so a probe cannot skip a number by
 * matching a longer one.
 */
import type { ShopifyClient } from '@/lib/shopify/client'
import { ShopifyError } from '@/lib/shopify/errors'

import { formatSku, renderTitle, slugifyHandle } from './identity'

/**
 * How many occupied numbers one publish will step over before giving up.
 *
 * Generous enough to walk past a batch listed by hand this morning, bounded so a
 * pathological catalogue cannot hold a publish open indefinitely (hard rule 4).
 * Hitting it means something is wrong that a human should look at, so it raises
 * rather than issuing the last candidate it happened to reach.
 */
export const MAX_NUMBER_PROBES = 40

export interface OccupiedNumber {
  readonly number: number
  readonly sku: string
  readonly handle: string
  readonly bySku: boolean
  readonly byHandle: boolean
}

export interface NumberingResult {
  /** The first number free in both Loupe and Shopify. */
  readonly nextFree: number
  /** Numbers Shopify already occupies that were stepped over. */
  readonly skipped: readonly OccupiedNumber[]
  /** What the counter was raised to, or null when it was already correct. */
  readonly raisedTo: number | null
  readonly probes: number
}

interface ProbeResponse {
  variants: { nodes: readonly { id: string }[] } | null
  product: { id: string } | null
}

/**
 * One request, two indexed lookups. Aliased rather than issued separately so a
 * publish pays a single round trip for both halves of the question.
 */
const PROBE_QUERY = /* GraphQL */ `
  query LoupeNumberInUse($sku: String!, $handle: String!) {
    variants: productVariants(first: 1, query: $sku) {
      nodes {
        id
      }
    }
    product: productByIdentifier(identifier: { handle: $handle }) {
      id
    }
  }
`

export interface NumberingInput {
  readonly prefix: string
  readonly titlePattern: string
  readonly titleSuffix: string | null
  /** `sku_counters.last_number`; the next number issued is this plus one. */
  readonly counterLastNumber: number
}

/**
 * Finds the first number free in Shopify at or after the counter's next, and
 * raises the counter so `next_sku()` issues exactly that.
 *
 * Raising to `nextFree - 1` rather than to `nextFree` is deliberate:
 * `next_sku()` increments before returning, so the counter must sit one below
 * the number we intend it to hand out. Doing it any other way burns a number
 * every time this runs.
 */
export async function findFreeNumber(
  client: ShopifyClient,
  input: NumberingInput,
): Promise<Omit<NumberingResult, 'raisedTo'>> {
  const skipped: OccupiedNumber[] = []
  const start = input.counterLastNumber + 1

  for (let probes = 1; probes <= MAX_NUMBER_PROBES; probes += 1) {
    const candidate = start + probes - 1
    const sku = formatSku(input.prefix, candidate)
    const handle = slugifyHandle(
      renderTitle(input.titlePattern, candidate, input.titleSuffix),
    )

    const data = await client.graphql<ProbeResponse>(PROBE_QUERY, {
      sku: `sku:${sku}`,
      handle,
    })
    const bySku = (data.variants?.nodes.length ?? 0) > 0
    const byHandle = data.product !== null

    if (!bySku && !byHandle) {
      return { nextFree: candidate, skipped, probes }
    }
    skipped.push({ number: candidate, sku, handle, bySku, byHandle })
  }

  throw new ShopifyError(
    `The next ${MAX_NUMBER_PROBES} ${input.prefix} numbers from ${start} are all already used in Shopify.`,
    {
      kind: 'graphql',
      retryable: false,
      hint:
        `Loupe steps over numbers listed by hand, but not ${MAX_NUMBER_PROBES} of them in a row. ` +
        `Run Full reconciliation to resynchronise the ${input.prefix} counter, then try again.`,
      detail: { prefix: input.prefix, start, skipped },
    },
  )
}

export interface CounterRaiser {
  (prefix: string, to: number): Promise<void>
}

/**
 * The whole guard: probe, then raise the counter past anything occupied.
 *
 * Safe to call before every publish. When nothing has been listed by hand it is
 * one round trip and no write; the counter is only touched when Shopify is
 * genuinely ahead, and `raise_sku_counter` is monotone so it can never walk a
 * sequence backwards even if two publishes race.
 *
 * This does NOT reserve anything. It leaves the counter positioned so the very
 * next `next_sku()` issues a number Shopify was not using a moment ago — and the
 * handle-ownership check at write time covers the remaining sliver where
 * somebody creates that exact product in between.
 */
export async function clearCounterOfShopifyNumbers(
  client: ShopifyClient,
  input: NumberingInput,
  raise: CounterRaiser,
): Promise<NumberingResult> {
  const found = await findFreeNumber(client, input)

  if (found.skipped.length === 0) {
    return { ...found, raisedTo: null }
  }

  const raisedTo = found.nextFree - 1
  await raise(input.prefix, raisedTo)
  return { ...found, raisedTo }
}
