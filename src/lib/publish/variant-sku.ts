import { comparableOptionValue } from '@/lib/shopify/colour-options'

export type SkuScheme = 'legacy' | 'variant-v1'
export type SkuVariantKind = 'none' | 'colour' | 'number' | 'size' | 'colour_size'

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
  sizeValue?: string | null,
): string {
  if (kind === 'colour_size') {
    if (scheme !== 'variant-v1') throw new Error('Colour and size combinations need separate barcodes. Start a new draft for this product; existing legacy drafts keep their saved codes.')
    if (!value?.trim() || !sizeValue?.trim()) throw new Error('Choose both a colour and a size for every combination.')
    const code = `${variantSku(base, 'colour', value, scheme)}-${variantSku('', 'size', sizeValue, scheme).slice(1)}`
    if (code.length > 64) throw new Error('Shorten the colour or size name so the barcode fits on a label.')
    return code
  }
  if (scheme === 'legacy' || kind === 'none' || value === null) return base
  const canonical = kind === 'colour' ? comparableOptionValue(value) : value.trim().toLowerCase().replace(/\s+/g, ' ')
  const suffix = canonical.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!suffix || suffix.length > 32) {
    throw new Error(`Use a shorter option name containing letters or numbers for “${value}” before creating its barcode.`)
  }
  return `${base}-${{ colour: 'C', number: 'N', size: 'S' }[kind]}-${suffix}`
}

/** Never silently collapse distinct option values to the same scannable code. */
export function variantSkus(base: string, kind: SkuVariantKind, values: readonly (string | { readonly value: string; readonly sizeValue?: string | null })[], scheme: SkuScheme): string[] {
  if (kind === 'colour_size' && scheme !== 'variant-v1') throw new Error('Start a new draft to use colour and size combinations with separate barcodes.')
  if (values.length > 100) throw new Error('Use at most 100 choices per product.')
  const codes = values.map(value => typeof value === 'string'
    ? variantSku(base, kind, value, scheme)
    : variantSku(base, kind, value.value, scheme, value.sizeValue))
  if (scheme !== 'legacy' && new Set(codes).size !== codes.length) {
    throw new Error('Two options produce the same barcode. Give each option a distinct name before saving.')
  }
  return codes
}
