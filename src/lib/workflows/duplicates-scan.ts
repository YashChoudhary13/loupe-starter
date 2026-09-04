/**
 * D122 — pure half of the duplicate-SKU step: groups variants by SKU and
 * flags handles that still carry Shopify's "-copy" suffix. Kept free of
 * server imports so it is unit-testable.
 */

export interface ProductRef {
  readonly id: string
  readonly handle: string
  readonly title: string
}

export interface DuplicateScan {
  readonly variants: number
  readonly duplicateSkus: readonly { readonly sku: string; readonly products: readonly ProductRef[] }[]
  readonly copiedHandles: readonly ProductRef[]
}

/** Pure: groups variants by SKU and flags handles that still carry Shopify's `-copy` suffix. */
export function scanDuplicates(
  variants: readonly { sku: string | null; product: ProductRef | null }[],
): DuplicateScan {
  const bySku = new Map<string, Map<string, ProductRef>>()
  const products = new Map<string, ProductRef>()
  for (const variant of variants) {
    if (!variant.product) continue
    products.set(variant.product.id, variant.product)
    const sku = variant.sku?.trim().toUpperCase() ?? ''
    if (!sku) continue
    const owners = bySku.get(sku) ?? new Map<string, ProductRef>()
    owners.set(variant.product.id, variant.product)
    bySku.set(sku, owners)
  }
  const duplicateSkus = [...bySku.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([sku, owners]) => ({ sku, products: [...owners.values()] }))
    .sort((left, right) => left.sku.localeCompare(right.sku))
  const copiedHandles = [...products.values()]
    .filter((product) => /-copy(-\d+)?$/.test(product.handle))
    .sort((left, right) => left.handle.localeCompare(right.handle))
  return { variants: variants.length, duplicateSkus, copiedHandles }
}
