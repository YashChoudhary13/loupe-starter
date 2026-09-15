import { comparableOptionValue } from '@/lib/shopify/colour-options'

export type SkuScheme = 'legacy' | 'variant-v1'
export type SkuVariantKind = 'none' | 'colour' | 'number' | 'size'

/** Parent numbers remain allocated atomically by Postgres. Never allocate here. */
export function parentSku(value: string): string | null {
  const match = /^([A-Z]{2,4}\d+)(?:-[CSN]-[A-Z0-9]+(?:-[A-Z0-9]+)*)?$/i.exec(value.trim())
  return match?.[1]?.toUpperCase() ?? null
}

export function variantSku(
  base: string,
  kind: SkuVariantKind,
  value: string | null,
  scheme: SkuScheme = 'legacy',
): string {
  if (scheme === 'legacy' || kind === 'none' || value === null) return base
  const canonical = kind === 'colour' ? comparableOptionValue(value) : value.trim().toLowerCase().replace(/\s+/g, ' ')
  const suffix = canonical.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!suffix || suffix.length > 32) {
    throw new Error(`Use a shorter option name containing letters or numbers for “${value}” before creating its barcode.`)
  }
  return `${base}-${{ colour: 'C', number: 'N', size: 'S' }[kind]}-${suffix}`
}

/** Never silently collapse distinct option values to the same scannable code. */
export function variantSkus(base: string, kind: SkuVariantKind, values: readonly string[], scheme: SkuScheme): string[] {
  const codes = values.map(value => variantSku(base, kind, value, scheme))
  if (scheme !== 'legacy' && new Set(codes).size !== codes.length) {
    throw new Error('Two options produce the same barcode. Give each option a distinct name before saving.')
  }
  return codes
}
