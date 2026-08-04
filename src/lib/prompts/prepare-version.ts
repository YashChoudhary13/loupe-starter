import {
  PRODUCT_BLOCK,
  PRODUCT_DESCRIPTION_TOKEN,
} from '@/lib/enhance/prompt'

export interface PreparedImagePrompt {
  readonly body: string
  /** True when Loupe inserted or canonicalised the required PRODUCT block. */
  readonly productBlockRepaired: boolean
}

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1
}

/**
 * Make a pasted image prompt safe for Loupe's description injection boundary.
 *
 * The PRODUCT block is application plumbing rather than creative wording. A
 * prompt pasted without it would previously be rejected after submission and
 * the browser redirect discarded the operator's edit. With no description
 * token, prepend the canonical block. With one recognisable but whitespace-
 * altered block, canonicalise it. Ambiguous occurrences are left untouched so
 * the database validator can refuse them rather than silently rewriting prose.
 */
export function prepareImagePromptBody(input: string): PreparedImagePrompt {
  const body = input.replace(/\r\n?/gu, '\n')
  if (body.includes(PRODUCT_BLOCK)) {
    return { body, productBlockRepaired: body !== input }
  }

  const count = occurrences(body, PRODUCT_DESCRIPTION_TOKEN)
  if (count === 0) {
    return {
      body: `${PRODUCT_BLOCK}${body.replace(/^\s+/u, '')}`,
      productBlockRepaired: true,
    }
  }

  if (count === 1) {
    const looseBlock =
      /(^|\n)[ \t]*PRODUCT[ \t]*\n[ \t]*\{\{PRODUCT_DESCRIPTION\}\}[ \t]*(?:\n[ \t]*)+/u
    if (looseBlock.test(body)) {
      return {
        body: body.replace(looseBlock, (_match, prefix: string) => `${prefix}${PRODUCT_BLOCK}`),
        productBlockRepaired: true,
      }
    }
  }

  return { body, productBlockRepaired: body !== input }
}
