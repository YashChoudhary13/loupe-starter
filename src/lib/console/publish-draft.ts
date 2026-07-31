import type { SupabaseClient } from '@supabase/supabase-js'

import type { DriveHousekeeper } from '@/lib/google/drive-types'
import { publishProduct } from '@/lib/publish/publish-product'
import type { PublishResult } from '@/lib/publish/types'
import type { ShopifyClient } from '@/lib/shopify/client'
import { readProductByHandle, readProductMedia, type ShopifyMedia } from '@/lib/shopify/product-set'

import { tidyDriveForDraft, type DriveHousekeepingOutcome } from './housekeeping'

/**
 * The console's publish: the existing publish path plus the three things only
 * the console needs — a lease, image URLs, and tidying Drive up afterwards.
 *
 * THE ORDER IS THE DESIGN (Phase 4 §15, hard rule 3):
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
 *
 * Every dependency is injected and this module is deliberately NOT `server-only`,
 * so `npm run verify:phase4` exercises this exact function rather than a
 * second publish path written to be scriptable. A parallel path would be a
 * parallel set of bugs.
 */

/** Long enough for a real productSet plus media upload, short enough to self-heal. */
export const PUBLISH_LEASE_SECONDS = 300

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

export interface ConsolePublishDeps {
  readonly db: SupabaseClient
  readonly shopify: ShopifyClient
  readonly drive: DriveHousekeeper
  readonly processedFolderId: string
  readonly signImageUrl: (storageKey: string) => Promise<string>
  /** Set false to prove that publication survives a failed tidy-up. */
  readonly housekeeping?: boolean
}

export async function publishDraftForOperator(
  draftId: string,
  actor: string,
  options: {
    allowZeroStock?: boolean
    extraTags?: readonly string[]
    /** D60: 'DRAFT' saves to Shopify unfinished; 'ACTIVE' publishes live. */
    shopifyStatus?: 'ACTIVE' | 'DRAFT'
  },
  deps: ConsolePublishDeps,
): Promise<ConsolePublishResult> {
  const { db, shopify } = deps

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
      // A Shopify DRAFT may legitimately have no photograph attached yet; the
      // ACTIVE path still refuses to publish a product with no image (D45).
      requireImages: options.shopifyStatus !== 'DRAFT',
      signImageUrl: deps.signImageUrl,
      shopifyStatus: options.shopifyStatus,
    })
  } finally {
    // Fenced release. If this publish overran its lease and a second attempt has
    // already claimed the draft, `end_draft_publish` returns false and leaves the
    // newer lease alone rather than unlocking somebody else's work.
    await db.rpc('end_draft_publish', { p_draft_id: draftId, p_lease_token: leaseToken })
  }

  // Read-back, not trust. A mutation reporting no errors is not the same as the
  // store holding what we meant.
  const [media, readback] = await Promise.all([
    readProductMedia(shopify, result.handle),
    readProductByHandle(shopify, result.handle),
  ])

  const housekeeping =
    // Moving the source file to /Processed means "this photograph is done".
    // A Shopify draft is not done, so a draft never tidies Drive.
    deps.housekeeping === false || options.shopifyStatus === 'DRAFT'
      ? []
      : await tidyDriveForDraft(draftId, {
          db,
          drive: deps.drive,
          processedFolderId: deps.processedFolderId,
          actor,
        })

  return { result, media: media ?? [], housekeeping, shopifyStatus: readback?.status ?? null }
}
