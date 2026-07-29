export const PRODUCT_DESCRIPTION_TOKEN = '{{PRODUCT_DESCRIPTION}}'
export const PRODUCT_BLOCK = `PRODUCT\n${PRODUCT_DESCRIPTION_TOKEN}\n\n`

export interface ResolvedImagePrompt {
  readonly text: string
  readonly descriptionInjected: boolean
  readonly descriptionMissing: boolean
}

function tokenCount(template: string): number {
  return template.split(PRODUCT_DESCRIPTION_TOKEN).length - 1
}

/**
 * This deliberately is not a template engine. The amendment specifies one
 * literal replacement token and one exact block-removal operation.
 */
export function resolveImagePrompt(
  template: string,
  description: string | null,
  injectDescription: boolean,
  descriptionMissing: boolean,
): ResolvedImagePrompt {
  if (tokenCount(template) !== 1 || !template.includes(PRODUCT_BLOCK)) {
    throw new Error(
      `The live image prompt must contain exactly one exact PRODUCT block: ${JSON.stringify(
        PRODUCT_BLOCK,
      )}`,
    )
  }

  const factualDescription = description?.trim() || null
  if (injectDescription && factualDescription) {
    return {
      text: template.replace(PRODUCT_DESCRIPTION_TOKEN, factualDescription),
      descriptionInjected: true,
      descriptionMissing: false,
    }
  }

  const text = template.replace(PRODUCT_BLOCK, '')
  if (
    text.includes(PRODUCT_DESCRIPTION_TOKEN) ||
    /^PRODUCT\s*$/m.test(text) ||
    text.startsWith('\n')
  ) {
    throw new Error('Removing the PRODUCT block left an invalid resolved image prompt.')
  }

  return {
    text,
    descriptionInjected: false,
    descriptionMissing,
  }
}
