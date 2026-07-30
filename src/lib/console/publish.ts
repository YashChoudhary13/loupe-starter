import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { googleDriveClient } from '@/lib/google/drive-server'
import type { DriveHousekeeper } from '@/lib/google/drive-types'
import { loadPublishInput, publishProduct } from '@/lib/publish/publish-product'
import type { PublishResult } from '@/lib/publish/types'
import { PublishBlockedError, validateDraftForPublish } from '@/lib/publish/validate'
import { ShopifyClient } from '@/lib/shopify/client'
import { shopifyConfig } from '@/lib/shopify/config'
import { readProductByHandle, readProductMedia, type ShopifyMedia } from '@/lib/shopify/product-set'
import { supabaseServer } from '@/lib/supabase/server'

import {
  tidyDriveForDraft as runDriveHousekeeping,
  type DriveHousekeepingOutcome,
} from './housekeeping'
import { signKey } from './images'

/**
 * The console's publish, which is the existing publish path plus three things
 * only the console needs: a lease, image URLs, and tidying Drive up afterwards.
 *
 * The ORDER is the design (Phase 4 §15, hard rule 3):
 *
 *   1. take the publish lease            — so a double-click cannot run twice
 *   2. publishProduct()                  — reserve, productSet, media, record
 *   3. release the lease                 — fenced by token
 *   4. read the product back             — evidence, not the mutation's own word
 *   5. THEN move the Drive files         — best effort, never a state transition
 *
 * Step 5 is last and separate on purpose. Drive housekeeping failing must leave
 * a published product and published intake rows exactly as they are; the only
 * thing it may change is `drive_processed_error` and an event somebody can read.
 */

/** Long enough for a real productSet plus media upload, short enough to self-heal. */
export const PUBLISH_LEASE_SECONDS = 300

/** Shopify fetches image URLs itself; they only need to survive that fetch. */
export const SHOPIFY_FETCH_TTL_SECONDS = 15 * 60

export interface ConsolePublishResult {
  readonly result: PublishResult
  readonly media: readonly ShopifyMedia[]
  readonly housekeeping: readonly DriveHousekeepingOutcome[]
  readonly shopifyStatus: string | null
}

export class PublishInProgressError extends Error {
  constructor() {
    super(
      'This product is already being published. Wait for it to finish — pressing Publish ' +
        'again cannot create a second product, but it will not make this one faster either.',
    )
    this.name = 'PublishInProgressError'
  }
}

export interface PublishDeps {
  readonly db?: SupabaseClient
  readonly shopify?: ShopifyClient
  readonly drive?: DriveHousekeeper
  readonly processedFolderId?: string
  /** Injected so a forced-failure test can prove publication survives it. */
  readonly signImageUrl?: (storageKey: string) => Promise<string>
}

/**
 * Validation for the UI: everything wrong, at once, without touching anything.
 *
 * Same function the publish path runs (`validateDraftForPublish`), never a
 * parallel UI-only ruleset — a client check that disagrees with the server is
 * how a "publishable" draft ends up refused at the last step.
 */
export async function describeBlocks(draftId: string, allowZeroStock: boolean) {
  const input = await loadPublishInput(supabaseServer(), draftId)
  return validateDraftForPublish(input, { allowZeroStock })
}

export async function publishDraftForOperator(
  draftId: string,
  operator: Operator,
  options: { allowZeroStock?: boolean; extraTags?: readonly string[] } = {},
  deps: PublishDeps = {},
): Promise<ConsolePublishResult> {
  const db = deps.db ?? supabaseServer()
  const shopify = deps.shopify ?? new ShopifyClient({ config: shopifyConfig() })
  const actor = operator.email

  const { data: token, error: leaseError } = await db.rpc('begin_draft_publish', {
    p_draft_id: draftId,
    p_lease_seconds: PUBLISH_LEASE_SECONDS,
    p_actor: actor,
  })
  if (leaseError) {
    if (leaseError.code === '55000') throw new PublishInProgressError()
    throw new Error(`Could not start publishing draft ${draftId}: ${leaseError.message}`)
  }
  const leaseToken = token as string

  let result: PublishResult
  try {
    result = await publishProduct(db, shopify, draftId, {
      actor,
      allowZeroStock: options.allowZeroStock,
      extraTags: options.extraTags,
      requireImages: true,
      signImageUrl:
        deps.signImageUrl ??
        (async (storageKey) => {
          const signed = await signKey(storageKey, SHOPIFY_FETCH_TTL_SECONDS)
          if (!signed) throw new Error(`No R2 object for ${storageKey}`)
          return signed.url
        }),
    })
  } finally {
    // Fenced release. If this publish took longer than its lease and a second
    // attempt already claimed the draft, `end_draft_publish` returns false and
    // leaves the newer lease alone rather than unlocking somebody else's work.
    await db.rpc('end_draft_publish', { p_draft_id: draftId, p_lease_token: leaseToken })
  }

  // Read-back, not trust. The mutation reporting no errors is not the same as
  // the store holding what we meant.
  const [media, readback] = await Promise.all([
    readProductMedia(shopify, result.handle),
    readProductByHandle(shopify, result.handle),
  ])

  const housekeeping = await tidyDriveForDraft(draftId, operator, deps)

  return {
    result,
    media: media ?? [],
    housekeeping,
    shopifyStatus: readback?.status ?? null,
  }
}

/**
 * Production wiring for the tidy-up. The logic — and every one of its failure
 * paths — lives in ./housekeeping.ts so it can be exercised without a real Google
 * credential.
 */
export async function tidyDriveForDraft(
  draftId: string,
  operator: Operator,
  deps: PublishDeps = {},
): Promise<readonly DriveHousekeepingOutcome[]> {
  return runDriveHousekeeping(draftId, {
    db: deps.db ?? supabaseServer(),
    drive: deps.drive ?? googleDriveClient(),
    processedFolderId: deps.processedFolderId ?? serverEnv.driveProcessedFolderId,
    actor: operator.email,
  })
}

export { PublishBlockedError }
export type { DriveHousekeepingOutcome }
