import { comparableOptionValue } from '@/lib/shopify/colour-options'
import { DEFAULT_OPTION_NAME, DEFAULT_OPTION_VALUE } from '@/lib/shopify/product-set'

/**
 * Reconciliation compares STRUCTURE, not editorial content. See D90.
 *
 * D54 built this to diff every field, on the assumption that Loupe publishes a
 * product and owns it afterwards. That assumption is wrong. Loupe's job ends
 * when the product exists in Shopify; the business then finishes the listing in
 * Shopify admin — correcting the material bullet, adjusting price, appending a
 * title suffix like "(ball back)", swapping photographs — and publishes
 * everything together at launch.
 *
 * The first run with real data proved the cost: 45 issues across 23 of 53
 * products, every one of them a deliberate edit, and the same 45 would have
 * reappeared every morning until somebody stopped reading Tracking. Alerting
 * that cries wolf is worse than no alerting (hard rule 5).
 *
 * So the split is by OWNERSHIP, not by importance:
 *
 *   Loupe's, still checked          the product exists; the handle it is
 *                                   addressed by; its SKU; how many variants it
 *                                   has and what they are called.
 *
 *   the business's, not checked     status (a Shopify DRAFT awaiting launch is
 *                                   the normal resting state, not drift), title,
 *                                   product type, tags, description, material
 *                                   metafield, price, weight, media.
 *
 * Inventory quantity is deliberately absent from both lists. D54 settled that
 * changing stock is not drift, and it is the one field guaranteed to move on its
 * own the moment the store starts selling.
 */

export interface ExpectedReconciliationProduct {
  readonly draftId: string
  readonly shopifyProductId: string | null
  /** The idempotency key (hard rule 2). */
  readonly handle: string
  /** Message text only — nothing compares it, because the business edits it. */
  readonly title: string
  readonly variants: readonly {
    readonly sku: string
    readonly optionName: 'Color' | 'Number' | 'Size' | null
    readonly optionValue: string | null
  }[]
}

export interface ActualReconciliationProduct {
  readonly id: string
  readonly handle: string
  /** Message text only — nothing compares it. */
  readonly title: string
  readonly variants: {
    readonly nodes: readonly {
      readonly sku: string | null
      readonly selectedOptions: readonly { readonly name: string; readonly value: string }[]
    }[]
  }
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

  /**
   * Deleted in Shopify. The SKU number is spent and the draft still claims the
   * product exists, so nothing else about it can be trusted — report this alone
   * rather than adding six consequential mismatches underneath it.
   */
  if (!actual) {
    return [
      issue(
        expected,
        'product_missing',
        'product',
        expected.shopifyProductId,
        null,
        `${expected.title} no longer exists in Shopify. Its ${expected.variants[0]?.sku ?? 'SKU'} number is spent.`,
      ),
    ]
  }

  const issues: ReconciliationIssue[] = []

  /**
   * `productSet` is identified BY HANDLE (hard rule 2), so the handle is what
   * makes a retry update the existing product instead of creating a twin. A
   * handle edited in admin silently turns the next Save Draft into a duplicate
   * listing carrying a duplicate SKU — the D2 failure by another road.
   *
   * Renaming a product in admin does not change its handle, so this stays quiet
   * through the ordinary launch edits.
   */
  if (expected.handle !== actual.handle) {
    issues.push(
      issue(
        expected,
        'field_mismatch',
        'handle',
        expected.handle,
        actual.handle,
        `${actual.title} has a different Shopify handle, so the next save would create a second product instead of updating this one.`,
      ),
    )
  }

  /**
   * The variant structure: how many, what each is called, and the SKU on each.
   *
   * This is where a repurposed listing shows up. AK089 was published as
   * "Anklets 089 (Single Piece)" and is now titled "Rings 229" in admin — the
   * title change is the business's business, but the SKU underneath it is not:
   * an anklet number is now attached to a ring, and the next AK the counter
   * issues will sit beside a product that is not an anklet.
   */
  if (actual.variants.nodes.length !== expected.variants.length) {
    issues.push(
      issue(
        expected,
        'variant_count_mismatch',
        'variants',
        expected.variants.length,
        actual.variants.nodes.length,
        `${actual.title} has ${actual.variants.nodes.length} Shopify variants; Loupe's draft has ${expected.variants.length}.`,
      ),
    )
  }

  expected.variants.forEach((variant, index) => {
    const observed = actual.variants.nodes[index]
    if (!observed) return

    if (variant.sku !== observed.sku) {
      issues.push(
        issue(
          expected,
          'field_mismatch',
          `variants.${index}.sku`,
          variant.sku,
          observed.sku,
          `${actual.title} variant ${index + 1} carries SKU ${observed.sku ?? '(none)'}, not the ${variant.sku} Loupe reserved.`,
        ),
      )
    }

    const observedOption = observed.selectedOptions[0] ?? null
    const expectedOption =
      variant.optionName && variant.optionValue
        ? { name: variant.optionName, value: variant.optionValue }
        : { name: DEFAULT_OPTION_NAME, value: DEFAULT_OPTION_VALUE }
    /**
     * The option NAME is structural ('Color'/'Number'/'Size' — Loupe wrote it)
     * and stays exact. The VALUE is judged by the same canonicaliser the
     * publish path used to select the saved Color entry, so "Multi Colour" vs
     * Shopify's "Multicolor" — same entry, different spelling convention — is
     * not drift. A genuinely different value still is.
     */
    const optionDiffers =
      observedOption === null
        ? true
        : expectedOption.name !== observedOption.name ||
          comparableOptionValue(expectedOption.value) !==
            comparableOptionValue(observedOption.value)
    if (optionDiffers) {
      issues.push(
        issue(
          expected,
          'field_mismatch',
          `variants.${index}.option`,
          expectedOption,
          observedOption,
          `${actual.title} variant ${index + 1} is ${observedOption ? `${observedOption.name} "${observedOption.value}"` : 'missing its option'}; Loupe's draft says ${expectedOption.name} "${expectedOption.value}".`,
        ),
      )
    }
  })

  return issues
}
