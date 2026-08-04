import { describe, expect, it } from 'vitest'

import {
  PRODUCT_BLOCK,
  PRODUCT_DESCRIPTION_TOKEN,
  resolveImagePrompt,
} from '@/lib/enhance/prompt'
import { prepareImagePromptBody } from '@/lib/prompts/prepare-version'

const SELF_STAGING = 'Create a clean catalogue image on ivory satin.'

describe('image prompt version preparation', () => {
  it('adds the required product-description block to an ordinary pasted prompt', () => {
    const prepared = prepareImagePromptBody(SELF_STAGING)

    expect(prepared.productBlockRepaired).toBe(true)
    expect(prepared.body).toBe(`${PRODUCT_BLOCK}${SELF_STAGING}`)
    expect(() =>
      resolveImagePrompt(
        prepared.body,
        'A factual jewellery description.',
        true,
        false,
        'flat-curve',
        false,
      ),
    ).not.toThrow()
  })

  it('keeps an already valid image prompt byte-for-byte', () => {
    const valid = `${PRODUCT_BLOCK}${SELF_STAGING}\n\n{{COMPOSITION_DETAIL}}`
    expect(prepareImagePromptBody(valid)).toEqual({
      body: valid,
      productBlockRepaired: false,
    })
  })

  it('canonicalises harmless whitespace around an existing product block', () => {
    const loose = `PRODUCT  \r\n  ${PRODUCT_DESCRIPTION_TOKEN}  \r\n \r\n${SELF_STAGING}`
    const prepared = prepareImagePromptBody(loose)

    expect(prepared.productBlockRepaired).toBe(true)
    expect(prepared.body).toBe(`${PRODUCT_BLOCK}${SELF_STAGING}`)
  })

  it('does not silently rewrite an ambiguous duplicate token', () => {
    const duplicate = `${PRODUCT_BLOCK}${SELF_STAGING}\n${PRODUCT_DESCRIPTION_TOKEN}`
    expect(prepareImagePromptBody(duplicate).body).toBe(duplicate)
  })
})
