import 'server-only'

import type { Operator } from '@/lib/auth/authorize'
import { loadPublishInput, reserveIdentityForSave } from '@/lib/publish/publish-product'
import { PublishBlockedError, validateDraftForPublish } from '@/lib/publish/validate'
import { ShopifyClient } from '@/lib/shopify/client'
import { shopifyConfig } from '@/lib/shopify/config'
import { supabaseServer } from '@/lib/supabase/server'

import { signKey } from './images'
import {
  publishDraftForOperator as runPublish,
  PublishInProgressError,
  type ConsolePublishResult,
} from './publish-draft'

/**
 * Production wiring for the console's publish.
 *
 * The logic lives in ./publish-draft.ts with every dependency injected, so
 * `npm run verify:phase4` runs the same code against the real store instead of
 * a second publish path written to be scriptable. This file is only the place
 * where "the real Shopify client and the real R2 signer" is decided.
 */

/** Shopify fetches image URLs itself; they only need to survive that fetch. */
export const SHOPIFY_FETCH_TTL_SECONDS = 15 * 60

async function signForShopify(storageKey: string): Promise<string> {
  const signed = await signKey(storageKey, SHOPIFY_FETCH_TTL_SECONDS)
  if (!signed) throw new Error(`No R2 object for ${storageKey}`)
  return signed.url
}

/**
 * Validation for the UI: everything wrong, at once, without touching anything.
 *
 * The same function the publish path runs, never a parallel UI-only ruleset — a
 * client check that disagrees with the server is how a "publishable" draft ends
 * up refused at the last step.
 */
export async function describeBlocks(draftId: string, allowZeroStock: boolean) {
  const input = await loadPublishInput(supabaseServer(), draftId)
  return validateDraftForPublish(input, { allowZeroStock })
}

export async function publishDraftForOperator(
  draftId: string,
  operator: Operator,
  options: {
    allowZeroStock?: boolean
    extraTags?: readonly string[]
    shopifyStatus?: 'ACTIVE' | 'DRAFT'
  } = {},
): Promise<ConsolePublishResult> {
  return runPublish(draftId, operator.email, options, {
    db: supabaseServer(),
    shopify: new ShopifyClient({ config: shopifyConfig() }),
    signImageUrl: signForShopify,
  })
}

/**
 * Save-time reservation (D107), production wiring. Runs inside the Save draft
 * click so the response carries the SKU `next_sku()` actually issued; the
 * background push then reuses it (hard rule 2).
 */
export async function reserveDraftIdentity(draftId: string, operator: Operator): Promise<void> {
  await reserveIdentityForSave(
    supabaseServer(),
    new ShopifyClient({ config: shopifyConfig() }),
    draftId,
    operator.email,
  )
}

export { PublishBlockedError, PublishInProgressError }
export type { ConsolePublishResult }
