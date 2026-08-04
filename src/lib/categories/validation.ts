export interface CategoryDraftInput {
  readonly name: string
  readonly skuPrefix: string
  /** Human title before Loupe appends the padded number. */
  readonly titleBase: string
  readonly shopifyTag: string
  readonly shopifyTaxonomyCategoryId: string
}

export interface ValidCategoryInput {
  readonly name: string
  readonly skuPrefix: string
  readonly titlePattern: string
  readonly shopifyTag: string
  readonly shopifyTaxonomyCategoryId: string
}

export type CategoryValidationResult =
  | { readonly ok: true; readonly value: ValidCategoryInput }
  | { readonly ok: false; readonly message: string }

function clean(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

export function suggestedSkuPrefix(name: string): string {
  const words = clean(name)
    .split(' ')
    .map((word) => word.replace(/[^A-Za-z]/gu, ''))
    .filter(Boolean)

  if (words.length >= 2) return words.slice(0, 4).map((word) => word[0]).join('').toUpperCase()
  return (words[0] ?? '').slice(0, 2).toUpperCase()
}

export function suggestedTitleBase(name: string): string {
  const value = clean(name)
  if (/ies$/iu.test(value)) return `${value.slice(0, -3)}y`
  if (/s$/iu.test(value) && !/ss$/iu.test(value)) return value.slice(0, -1)
  return value
}

export function validateCategoryInput(input: CategoryDraftInput): CategoryValidationResult {
  const name = clean(input.name)
  const skuPrefix = clean(input.skuPrefix).toUpperCase()
  const titleBase = clean(input.titleBase)
  const shopifyTag = clean(input.shopifyTag)
  const shopifyTaxonomyCategoryId = clean(input.shopifyTaxonomyCategoryId)

  if (name.length < 2 || name.length > 80) {
    return { ok: false, message: 'Category name must be between 2 and 80 characters.' }
  }
  if (!/^[A-Z]{2,4}$/u.test(skuPrefix)) {
    return { ok: false, message: 'SKU letters must be 2 to 4 letters, for example WC.' }
  }
  if (titleBase.length < 2 || titleBase.length > 90 || titleBase.includes('{n}')) {
    return {
      ok: false,
      message: 'Product title must be 2 to 90 characters. Enter only the wording before the number.',
    }
  }
  if (!shopifyTag || shopifyTag.length > 100) {
    return {
      ok: false,
      message: 'Enter the exact Shopify collection tag, including its spelling and casing.',
    }
  }
  if (!/^gid:\/\/shopify\/TaxonomyCategory\/[a-z0-9-]+$/u.test(shopifyTaxonomyCategoryId)) {
    return { ok: false, message: 'Choose a Shopify product category from the search results.' }
  }

  return {
    ok: true,
    value: {
      name,
      skuPrefix,
      titlePattern: `${titleBase} {n}`,
      shopifyTag,
      shopifyTaxonomyCategoryId,
    },
  }
}
