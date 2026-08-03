import { DEFAULT_OPTION_NAME, DEFAULT_OPTION_VALUE } from '@/lib/shopify/product-set'

export interface ExpectedReconciliationProduct {
  readonly draftId: string
  readonly shopifyProductId: string | null
  readonly handle: string
  readonly title: string
  readonly productType: string
  readonly requiredTags: readonly string[]
  readonly descriptionHtml: string
  readonly material: string | null
  readonly variants: readonly {
    readonly sku: string
    readonly price: string
    readonly weightG: number
    readonly optionName: 'Colour' | 'Number' | 'Size' | null
    readonly optionValue: string | null
  }[]
  readonly mediaIds: readonly string[]
  readonly missingRecordedMedia: boolean
}

export interface ActualReconciliationProduct {
  readonly id: string
  readonly handle: string
  readonly title: string
  readonly status: string
  readonly productType: string | null
  readonly tags: readonly string[]
  readonly descriptionHtml: string
  readonly metafield: { readonly value: string } | null
  readonly variants: {
    readonly nodes: readonly {
      readonly sku: string | null
      readonly price: string
      readonly selectedOptions: readonly { readonly name: string; readonly value: string }[]
      readonly inventoryItem: {
        readonly measurement: {
          readonly weight: { readonly value: number; readonly unit: string } | null
        } | null
      } | null
    }[]
  }
  readonly media: { readonly nodes: readonly { readonly id: string }[] }
}

export interface ReconciliationIssue {
  readonly productDraftId: string
  readonly shopifyProductId: string | null
  readonly code: string
  readonly field: string
  readonly expected: unknown
  readonly actual: unknown
  readonly message: string
}

function canonicalHtml(value: string): string {
  return value.trim().replace(/>\s+</g, '><')
}

function issue(
  product: ExpectedReconciliationProduct,
  code: string,
  field: string,
  expected: unknown,
  actual: unknown,
  message: string,
): ReconciliationIssue {
  return {
    productDraftId: product.draftId,
    shopifyProductId: product.shopifyProductId,
    code,
    field,
    expected,
    actual,
    message,
  }
}

export function comparePublishedProduct(
  expected: ExpectedReconciliationProduct,
  actual: ActualReconciliationProduct | null,
): readonly ReconciliationIssue[] {
  if (!expected.shopifyProductId) {
    return [
      issue(
        expected,
        'local_product_id_missing',
        'shopifyProductId',
        'A published draft must record a Shopify product ID.',
        null,
        `${expected.title || expected.draftId} is published in Loupe but has no Shopify product ID.`,
      ),
    ]
  }
  if (!actual) {
    return [
      issue(
        expected,
        'product_missing',
        'product',
        expected.shopifyProductId,
        null,
        `${expected.title} no longer exists in Shopify.`,
      ),
    ]
  }

  const issues: ReconciliationIssue[] = []
  const exact = (
    field: string,
    expectedValue: unknown,
    actualValue: unknown,
    message: string,
  ) => {
    if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
      issues.push(
        issue(expected, 'field_mismatch', field, expectedValue, actualValue, message),
      )
    }
  }

  exact('status', 'ACTIVE', actual.status, `${expected.title} is no longer active in Shopify.`)
  exact('handle', expected.handle, actual.handle, `${expected.title} has a different Shopify handle.`)
  exact('title', expected.title, actual.title, `${expected.title} has a different Shopify title.`)
  exact(
    'productType',
    expected.productType,
    actual.productType,
    `${expected.title} has a different product type.`,
  )

  const missingTags = expected.requiredTags.filter((tag) => !actual.tags.includes(tag))
  if (missingTags.length > 0) {
    issues.push(
      issue(
        expected,
        'required_tag_missing',
        'tags',
        expected.requiredTags,
        actual.tags,
        `${expected.title} is missing required ${missingTags.join(', ')} tag${missingTags.length === 1 ? '' : 's'}.`,
      ),
    )
  }

  if (canonicalHtml(expected.descriptionHtml) !== canonicalHtml(actual.descriptionHtml)) {
    issues.push(
      issue(
        expected,
        'field_mismatch',
        'descriptionHtml',
        canonicalHtml(expected.descriptionHtml),
        canonicalHtml(actual.descriptionHtml),
        `${expected.title} has a different product description.`,
      ),
    )
  }
  exact(
    'material',
    expected.material,
    actual.metafield?.value ?? null,
    `${expected.title} has a different material metafield.`,
  )

  if (actual.variants.nodes.length !== expected.variants.length) {
    issues.push(
      issue(
        expected,
        'variant_count_mismatch',
        'variants',
        expected.variants.length,
        actual.variants.nodes.length,
        `${expected.title} has ${actual.variants.nodes.length} Shopify variants; Loupe expects ${expected.variants.length}.`,
      ),
    )
  }

  expected.variants.forEach((variant, index) => {
    const observed = actual.variants.nodes[index]
    if (!observed) return
    exact(
      `variants.${index}.sku`,
      variant.sku,
      observed.sku,
      `${expected.title} variant ${index + 1} has a different SKU.`,
    )
    exact(
      `variants.${index}.price`,
      variant.price,
      observed.price,
      `${expected.title} variant ${index + 1} has a different price.`,
    )
    const option = observed.selectedOptions[0] ?? null
    const expectedOption = variant.optionName && variant.optionValue
      ? { name: variant.optionName, value: variant.optionValue }
      : { name: DEFAULT_OPTION_NAME, value: DEFAULT_OPTION_VALUE }
    exact(
      `variants.${index}.option`,
      expectedOption,
      option,
      `${expected.title} variant ${index + 1} has a different option value.`,
    )
    const weight = observed.inventoryItem?.measurement?.weight
    exact(
      `variants.${index}.weight`,
      { value: variant.weightG, unit: 'GRAMS' },
      weight ? { value: weight.value, unit: weight.unit } : null,
      `${expected.title} variant ${index + 1} has a different weight.`,
    )
  })

  const actualMediaIds = actual.media.nodes.map((media) => media.id)
  if (expected.missingRecordedMedia || expected.mediaIds.length === 0) {
    issues.push(
      issue(
        expected,
        'local_media_id_missing',
        'media',
        'Every published draft image must record its Shopify media ID.',
        expected.mediaIds,
        `${expected.title} has a published image without a recorded Shopify media ID.`,
      ),
    )
  }
  exact(
    'media',
    expected.mediaIds,
    actualMediaIds,
    `${expected.title} has different Shopify images or image order.`,
  )

  return issues
}
