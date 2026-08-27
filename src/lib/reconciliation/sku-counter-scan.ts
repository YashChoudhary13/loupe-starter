import {
  KNOWN_MALFORMED_SKU_CORRECTIONS,
  malformedSkuCorrection,
  parseSku,
} from '@/lib/publish/identity'

export interface ShopifySkuVariant {
  readonly sku: string | null
  readonly title: string
}

export interface PrefixFinding {
  readonly prefix: string
  max: number
  count: number
  exampleSku: string
  exampleTitle: string
}

export interface ExcludedMalformedSku {
  readonly sku: string
  readonly title: string
  readonly correctedSku: string
}

export interface SkuCounterScan {
  readonly findings: Map<string, PrefixFinding>
  readonly scanned: number
  readonly blank: number
  readonly unparseable: readonly { sku: string; title: string }[]
  readonly excludedMalformed: readonly ExcludedMalformedSku[]
}

export interface SkuCounterState {
  readonly prefix: string
  readonly current: number
}

export interface SkuCounterPlanRow {
  readonly prefix: string
  readonly from: number
  readonly shopifyMax: number | null
  readonly action: 'raise' | 'already-current' | 'counter-ahead' | 'absent-in-shopify'
}

/**
 * Confirmed catalogue typos which must never become sequence maxima.
 *
 * The product titles prove the intended numbers. Keep this list exact and
 * reviewable: a broad heuristic could silently discard a real high SKU, while
 * allowing one of these through would permanently raise a monotone counter.
 */
export const EXCLUDED_MALFORMED_SKUS = KNOWN_MALFORMED_SKU_CORRECTIONS

/**
 * Derives the true maximum for every prefix after removing only the explicitly
 * confirmed malformed SKUs. Exclusions remain visible in the return value so a
 * dry run and audit event can prove what was ignored.
 */
export function scanSkuVariants(variants: readonly ShopifySkuVariant[]): SkuCounterScan {
  const findings = new Map<string, PrefixFinding>()
  const unparseable: { sku: string; title: string }[] = []
  const excludedMalformed: ExcludedMalformedSku[] = []
  let blank = 0

  for (const variant of variants) {
    const sku = variant.sku?.trim() ?? ''
    if (sku === '') {
      blank += 1
      continue
    }

    const correctedSku = malformedSkuCorrection(sku)
    if (correctedSku) {
      excludedMalformed.push({ sku, title: variant.title, correctedSku })
      continue
    }

    const parsed = parseSku(sku)
    if (!parsed) {
      if (unparseable.length < 25) unparseable.push({ sku, title: variant.title })
      continue
    }

    const existing = findings.get(parsed.prefix)
    if (!existing) {
      findings.set(parsed.prefix, {
        prefix: parsed.prefix,
        max: parsed.number,
        count: 1,
        exampleSku: sku,
        exampleTitle: variant.title,
      })
      continue
    }

    existing.count += 1
    if (parsed.number > existing.max) {
      existing.max = parsed.number
      existing.exampleSku = sku
      existing.exampleTitle = variant.title
    }
  }

  return {
    findings,
    scanned: variants.length,
    blank,
    unparseable,
    excludedMalformed,
  }
}

/**
 * Plans the only safe automatic SKU correction: raising a known per-category
 * counter to a higher observed Shopify maximum. A missing or lower Shopify
 * maximum never walks the counter backwards and therefore never reuses a
 * deleted or already-reserved identity.
 */
export function planSkuCounterSync(
  counters: readonly SkuCounterState[],
  findings: ReadonlyMap<string, PrefixFinding>,
): readonly SkuCounterPlanRow[] {
  return counters.map((counter) => {
    const finding = findings.get(counter.prefix)
    if (!finding) {
      return {
        prefix: counter.prefix,
        from: counter.current,
        shopifyMax: null,
        action: 'absent-in-shopify' as const,
      }
    }
    if (finding.max > counter.current) {
      return {
        prefix: counter.prefix,
        from: counter.current,
        shopifyMax: finding.max,
        action: 'raise' as const,
      }
    }
    return {
      prefix: counter.prefix,
      from: counter.current,
      shopifyMax: finding.max,
      action: finding.max === counter.current ? ('already-current' as const) : ('counter-ahead' as const),
    }
  })
}
