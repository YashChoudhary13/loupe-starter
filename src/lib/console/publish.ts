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

export interface DriveHousekeepingOutcome {
  readonly intakeFileId: string
  readonly filename: string
  readonly driveFileId: string
  readonly ok: boolean
  /** False with `ok: true` means it was already in /Processed — a safe repeat. */
  readonly moved: boolean
  readonly error: string | null
}

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
 * Moves every source photograph of a published draft into Drive /Processed.
 *
 * Runs only after the database says published, and cannot fail the publish. Each
 * file is independent: one file that will not move must not stop the others, and
 * `record_drive_housekeeping` records the reason where the tracking page can
 * find it later.
 */
export async function tidyDriveForDraft(
  draftId: string,
  operator: Operator,
  deps: PublishDeps = {},
): Promise<readonly DriveHousekeepingOutcome[]> {
  const db = deps.db ?? supabaseServer()

  const { data, error } = await db
    .from('intake_files')
    .select('id, filename, drive_file_id, status, drive_processed_at')
    .eq('product_draft_id', draftId)
    .eq('status', 'published')
  if (error) throw new Error(`Could not read the draft's photographs: ${error.message}`)

  const rows = (data ?? []) as {
    id: string
    filename: string
    drive_file_id: string
    drive_processed_at: string | null
  }[]
  if (rows.length === 0) return []

  const drive = deps.drive ?? googleDriveClient()
  const processedFolderId = deps.processedFolderId ?? serverEnv.driveProcessedFolderId
  const outcomes: DriveHousekeepingOutcome[] = []

  for (const row of rows) {
    try {
      const move = await drive.moveToFolder(row.drive_file_id, processedFolderId)
      await db.rpc('record_drive_housekeeping', {
        p_intake_file_id: row.id,
        p_ok: true,
        p_error: null,
        p_actor: operator.email,
      })
      outcomes.push({
        intakeFileId: row.id,
        filename: row.filename,
        driveFileId: row.drive_file_id,
        ok: true,
        moved: move.moved,
        error: null,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await db.rpc('record_drive_housekeeping', {
        p_intake_file_id: row.id,
        p_ok: false,
        p_error: message,
        p_actor: operator.email,
      })
      outcomes.push({
        intakeFileId: row.id,
        filename: row.filename,
        driveFileId: row.drive_file_id,
        ok: false,
        moved: false,
        error: message,
      })
    }
  }

  return outcomes
}

export { PublishBlockedError }
