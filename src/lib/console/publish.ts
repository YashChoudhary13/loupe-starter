import 'server-only'

import type { Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { googleDriveClient } from '@/lib/google/drive-server'
import { loadPublishInput } from '@/lib/publish/publish-product'
import { PublishBlockedError, validateDraftForPublish } from '@/lib/publish/validate'
import { ShopifyClient } from '@/lib/shopify/client'
import { shopifyConfig } from '@/lib/shopify/config'
import { supabaseServer } from '@/lib/supabase/server'

import { tidyDriveForDraft as runDriveHousekeeping, type DriveHousekeepingOutcome } from './housekeeping'
import { signKey } from './images'
import {
  publishDraftForOperator as runPublish,
  PublishInProgressError,
  type ConsolePublishResult,
} from './publish-draft'

/**
 * Production wiring for the console's publish.
 *
 * The logic lives in ./publish-draft.ts and ./housekeeping.ts with every
 * dependency injected, so `npm run verify:phase4` runs the same code against the
 * real store instead of a second publish path written to be scriptable. This
 * file is only the place where "the real Shopify client, the real Drive client
 * and the real R2 signer" is decided.
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
  options: { allowZeroStock?: boolean; extraTags?: readonly string[] } = {},
): Promise<ConsolePublishResult> {
  return runPublish(draftId, operator.email, options, {
    db: supabaseServer(),
    shopify: new ShopifyClient({ config: shopifyConfig() }),
    drive: googleDriveClient(),
    processedFolderId: serverEnv.driveProcessedFolderId,
    signImageUrl: signForShopify,
  })
}

/** Retryable housekeeping on its own, for a product that published but was not tidied. */
export async function tidyDriveForDraft(
  draftId: string,
  operator: Operator,
): Promise<readonly DriveHousekeepingOutcome[]> {
  return runDriveHousekeeping(draftId, {
    db: supabaseServer(),
    drive: googleDriveClient(),
    processedFolderId: serverEnv.driveProcessedFolderId,
    actor: operator.email,
  })
}

export { PublishBlockedError, PublishInProgressError }
export type { ConsolePublishResult, DriveHousekeepingOutcome }
