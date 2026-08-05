import {
  compositionDetailFor,
  type PresentationClass,
} from './presentation'

export const PRODUCT_DESCRIPTION_TOKEN = '{{PRODUCT_DESCRIPTION}}'
export const COMPOSITION_DETAIL_TOKEN = '{{COMPOSITION_DETAIL}}'
export const PRODUCT_BLOCK = `PRODUCT\n${PRODUCT_DESCRIPTION_TOKEN}\n\n`
const RECOGNISED_TEMPLATE_TOKEN = /\{\{[A-Z][A-Z0-9_]*\}\}/gu

export interface ResolvedImagePrompt {
  readonly text: string
  readonly descriptionInjected: boolean
  readonly descriptionMissing: boolean
  /** Null when the prompt staged the product itself (no class was injected). */
  readonly compositionDetail: string | null
}

function tokenCount(template: string, token: string): number {
  return template.split(token).length - 1
}

function assertFullyResolved(text: string): void {
  const unresolved = [...text.matchAll(RECOGNISED_TEMPLATE_TOKEN)].map(
    (match) => match[0],
  )
  if (unresolved.length > 0) {
    throw new Error(
      `The resolved image prompt contains unresolved template tokens: ${[
        ...new Set(unresolved),
      ].join(', ')}.`,
    )
  }
}

/**
 * This deliberately is not a template engine. The amendment specifies two
 * literal replacement tokens and one exact block-removal operation.
 */
export function resolveImagePrompt(
  template: string,
  description: string | null,
  injectDescription: boolean,
  descriptionMissing: boolean,
  presentationClass: PresentationClass,
  /**
   * False for a preset that stages the product itself — "worn on a hand", "bag
   * standing upright". Those contradict the describer's composition classes,
   * which all describe a piece posed on a product-photography surface. Sending
   * both leaves the image model to resolve a
   * contradiction, which it does differently every time.
   */
  usesComposition = true,
): ResolvedImagePrompt {
  if (
    tokenCount(template, PRODUCT_DESCRIPTION_TOKEN) !== 1 ||
    !template.includes(PRODUCT_BLOCK)
  ) {
    throw new Error(
      `The live image prompt must contain exactly one exact PRODUCT block: ${JSON.stringify(
        PRODUCT_BLOCK,
      )}`,
    )
  }
  const expectedCompositionTokens = usesComposition ? 1 : 0
  if (tokenCount(template, COMPOSITION_DETAIL_TOKEN) !== expectedCompositionTokens) {
    throw new Error(
      usesComposition
        ? `The live image prompt must contain exactly one ${COMPOSITION_DETAIL_TOKEN} token.`
        : `This prompt stages the product itself, so it must NOT contain ${COMPOSITION_DETAIL_TOKEN}.`,
    )
  }

  const factualDescription = description?.trim() || null
  let text: string
  let descriptionInjected: boolean
  if (injectDescription && factualDescription) {
    text = template.replace(PRODUCT_DESCRIPTION_TOKEN, factualDescription)
    descriptionInjected = true
    descriptionMissing = false
  } else {
    text = template.replace(PRODUCT_BLOCK, '')
    descriptionInjected = false
    if (
      text.includes(PRODUCT_DESCRIPTION_TOKEN) ||
      /^PRODUCT\s*$/m.test(text) ||
      text.startsWith('\n')
    ) {
      throw new Error('Removing the PRODUCT block left an invalid resolved image prompt.')
    }
  }

  // A self-staging preset records null rather than a class it did not use, so
  // image_versions never claims a composition the model was not given.
  const compositionDetail = usesComposition ? compositionDetailFor(presentationClass) : null
  if (compositionDetail !== null) {
    text = text.replace(COMPOSITION_DETAIL_TOKEN, compositionDetail)
  }
  assertFullyResolved(text)

  return {
    text,
    descriptionInjected,
    descriptionMissing,
    compositionDetail,
  }
}
