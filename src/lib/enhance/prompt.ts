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
  readonly compositionDetail: string
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
  if (tokenCount(template, COMPOSITION_DETAIL_TOKEN) !== 1) {
    throw new Error(
      `The live image prompt must contain exactly one ${COMPOSITION_DETAIL_TOKEN} token.`,
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

  const compositionDetail = compositionDetailFor(presentationClass)
  text = text.replace(COMPOSITION_DETAIL_TOKEN, compositionDetail)
  assertFullyResolved(text)

  return {
    text,
    descriptionInjected,
    descriptionMissing,
    compositionDetail,
  }
}
