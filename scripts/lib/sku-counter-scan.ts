import { parseSku } from '../../src/lib/publish/identity'

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

/**
 * Confirmed catalogue typos which must never become sequence maxima.
 *
 * The product titles prove the intended numbers. Keep this list exact and
 * reviewable: a broad heuristic could silently discard a real high SKU, while
 * allowing one of these through would permanently raise a monotone counter.
 */
export const EXCLUDED_MALFORMED_SKUS = new Map<string, string>([
  ['NK7801', 'NK801'],
  ['BK3367', 'BK337'],
  ['AK0834', 'AK084'],
])

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

    const normalisedSku = sku.toUpperCase()
    const correctedSku = EXCLUDED_MALFORMED_SKUS.get(normalisedSku)
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
