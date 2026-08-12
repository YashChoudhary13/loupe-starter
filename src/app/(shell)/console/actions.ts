'use server'

import { after } from 'next/server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import {
  validateCategoryInput,
  type CategoryDraftInput,
} from '@/lib/categories/validation'
import { ConsoleError, createDraftFromPhotos, detachPhoto, saveDraft, type DraftSaveInput } from '@/lib/console/mutations'
import {
  describeBlocks,
  publishDraftForOperator,
  PublishInProgressError,
  type DriveHousekeepingOutcome,
} from '@/lib/console/publish'
import { pushDraftToShopifyInBackground } from '@/lib/console/shopify-push'
import {
  loadColourSuggestions,
  loadCatalog,
  loadDraft,
  loadPhotos,
  loadPipelineActivity,
  loadQueue,
} from '@/lib/console/queue'
import type {
  ColourSuggestion,
  CategoryOption,
  DraftDetail,
  PhotoSummary,
  PipelineActivity,
  QueueSnapshot,
} from '@/lib/console/types'
import { PublishBlockedError, type PublishBlock } from '@/lib/publish/validate'
import {
  beginManualUpload,
  finalizeManualUpload,
  type BeginManualUploadInput,
  type ManualUploadTicket,
} from '@/lib/manual-upload/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * Every mutation the console can make, and the only way the browser reaches the
 * database.
 *
 * TWO THINGS EVERY ACTION IN HERE DOES, WITHOUT EXCEPTION:
 *
 *   1. `requireOperatorForAction()` first. A server action is a public POST
 *      endpoint with a generated name — it is NOT protected by the page that
 *      renders its button. "The console already checked" is not a check.
 *   2. It takes ids, never records. A draft's price arrives as a number to store;
 *      what actually gets published is re-read from the database inside
 *      publishProduct(). Nothing the browser says about a draft is trusted as the
 *      thing to publish.
 *
 * Actions return a result rather than throwing, because every failure here has
 * an operator-facing sentence attached to it and a thrown error in a server
 * action reaches the browser as "an error occurred" (DESIGN.md · Language).
 */

export type ActionErrorKind = 'auth' | 'blocked' | 'conflict' | 'error'

export interface ActionError {
  readonly kind: ActionErrorKind
  /** Written for the operator. Safe to render. */
  readonly message: string
  /** For the Details expander. May name SQLSTATEs and tables; never secrets. */
  readonly detail: string | null
  readonly retryable: boolean
  /** Present for `blocked`: every reason at once, each naming its field. */
  readonly blocks: readonly PublishBlock[]
}

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ActionError }

function failure(kind: ActionErrorKind, message: string, detail: string | null, retryable: boolean, blocks: readonly PublishBlock[] = []): ActionResult<never> {
  return { ok: false, error: { kind, message, detail, retryable, blocks } }
}

/**
 * Turns anything thrown into something an operator can act on.
 *
 * The generic branch is deliberately vague about the cause and specific about
 * the consequence: an unknown error must never imply that data was saved.
 */
function toActionError(cause: unknown): ActionResult<never> {
  if (cause instanceof NotAuthorisedError) {
    return failure('auth', cause.message, null, false)
  }
  if (cause instanceof PublishBlockedError) {
    return failure(
      'blocked',
      'This product is not ready to publish. Nothing was sent to Shopify and no SKU was reserved.',
      null,
      true,
      cause.blocks,
    )
  }
  if (cause instanceof PublishInProgressError) {
    return failure('conflict', cause.message, null, true)
  }
  if (cause instanceof ConsoleError) {
    return failure(cause.retryable ? 'conflict' : 'error', cause.operatorMessage, cause.detail, cause.retryable)
  }
  const detail = cause instanceof Error ? cause.message : String(cause)
  console.error('console action failed:', detail)
  return failure(
    'error',
    'Something went wrong and this change was not saved. Nothing was published. Try again — if it keeps happening, show the details to whoever runs Loupe.',
    detail,
    true,
  )
}

async function withOperator<T>(run: (operator: Awaited<ReturnType<typeof requireOperatorForAction>>) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run(await requireOperatorForAction()) }
  } catch (cause) {
    return toActionError(cause)
  }
}

export async function refreshQueueAction(): Promise<ActionResult<QueueSnapshot>> {
  return withOperator(() => loadQueue())
}

export interface ShopifyTaxonomyOption {
  readonly id: string
  readonly name: string
  readonly fullName: string
}

interface TaxonomyCategoryNode extends ShopifyTaxonomyOption {
  readonly isLeaf: boolean
}

/**
 * Searches Shopify's own current taxonomy rather than making the operator type
 * or Loupe guess an opaque category id. Results are read-only and limited to
 * leaf categories that Shopify permits on a product.
 */
export async function searchShopifyTaxonomyAction(
  rawSearch: string,
): Promise<ActionResult<readonly ShopifyTaxonomyOption[]>> {
  return withOperator(async () => {
    const search = rawSearch.trim().replace(/\s+/gu, ' ')
    if (search.length < 2 || search.length > 80) {
      throw new ConsoleError(
        'Enter at least two characters to search Shopify product categories.',
        null,
        false,
      )
    }

    const client = new ShopifyClient()
    const data = await client.graphql<{
      taxonomy: { categories: { nodes: readonly TaxonomyCategoryNode[] } }
    }>(
      `query ConsoleTaxonomySearch($search: String!) {
        taxonomy {
          categories(first: 20, search: $search) {
            nodes { id name fullName isLeaf }
          }
        }
      }`,
      { search },
    )

    return data.taxonomy.categories.nodes
      .filter((category) => category.isLeaf)
      .slice(0, 12)
      .map(({ id, name, fullName }) => ({ id, name, fullName }))
  })
}

/** Creates the category and its independent SKU sequence as one transaction. */
export async function createCategoryAction(
  input: CategoryDraftInput,
): Promise<ActionResult<CategoryOption>> {
  return withOperator(async (operator) => {
    const parsed = validateCategoryInput(input)
    if (!parsed.ok) throw new ConsoleError(parsed.message, null, false)

    // The browser selected this id from search results, but the browser is not
    // an authority. Re-read it from Shopify and require a product-assignable
    // leaf category before storing it.
    const client = new ShopifyClient()
    const taxonomy = await client.graphql<{ node: TaxonomyCategoryNode | null }>(
      `query ConsoleTaxonomyCategory($id: ID!) {
        node(id: $id) {
          ... on TaxonomyCategory { id name fullName isLeaf }
        }
      }`,
      { id: parsed.value.shopifyTaxonomyCategoryId },
    )
    if (!taxonomy.node?.isLeaf || taxonomy.node.id !== parsed.value.shopifyTaxonomyCategoryId) {
      throw new ConsoleError(
        'That Shopify product category is no longer available. Search and choose another one.',
        null,
        true,
      )
    }

    const { data: categoryId, error } = await supabaseServer().rpc('create_console_category', {
      p_name: parsed.value.name,
      p_sku_prefix: parsed.value.skuPrefix,
      p_title_pattern: parsed.value.titlePattern,
      p_shopify_tag: parsed.value.shopifyTag,
      p_shopify_taxonomy_category_id: parsed.value.shopifyTaxonomyCategoryId,
      p_actor: operator.email,
    })
    if (error) {
      throw new ConsoleError(
        error.hint?.trim() || 'The new category could not be created.',
        [error.code, error.message].filter(Boolean).join(' · '),
        false,
      )
    }

    const catalog = await loadCatalog()
    const category = catalog.categories.find((option) => option.id === categoryId)
    if (!category) {
      throw new Error(`create_console_category returned ${String(categoryId)}, but it was not readable`)
    }
    return category
  })
}

/**
 * Creates a short-lived, single-object R2 upload URL. The browser writes the
 * ready image directly to the private bucket so Vercel's request-body ceiling
 * cannot truncate a photographer's full-resolution file.
 */
export async function beginManualUploadAction(
  input: BeginManualUploadInput,
): Promise<ActionResult<ManualUploadTicket>> {
  return withOperator((operator) => beginManualUpload(operator, input))
}

/**
 * Verifies the bytes and atomically makes the ready image visible in Pending.
 *
 * Returns only the intake id: the multi-file upload queue finalises several
 * files concurrently, and each carrying a full presigned queue snapshot made
 * every completion pay for a whole grid re-sign. The client refreshes the
 * queue once, debounced, as completions land.
 */
export async function finalizeManualUploadAction(
  uploadId: string,
): Promise<ActionResult<{ intakeFileId: string }>> {
  return withOperator(async (operator) => {
    const intakeFileId = await finalizeManualUpload(operator, uploadId)
    return { intakeFileId }
  })
}

/**
 * The cheap poll: two counters, no rows and no presigned URLs. The console asks
 * for this every few seconds while Drive intake is moving and only pays for a
 * full `refreshQueueAction()` when the counters say something actually finished.
 */
export async function pipelineActivityAction(): Promise<ActionResult<PipelineActivity>> {
  return withOperator(() => loadPipelineActivity())
}

/**
 * Versions and full-size images for photographs the operator has selected but
 * not yet grouped. Signed per selection rather than per tile, so reviewing one
 * product never costs twenty full-resolution downloads.
 */
export async function previewPhotosAction(
  intakeFileIds: readonly string[],
): Promise<ActionResult<readonly PhotoSummary[]>> {
  return withOperator(() => loadPhotos(intakeFileIds))
}

export interface RedoImageResult {
  readonly photo: PhotoSummary
  readonly jobId: string
  /**
   * The job is durable and running in the background. The returned photo
   * already carries `redo.status = 'queued'`, so the console renders progress
   * immediately and the live heartbeat swaps in the new version when
   * `image.redo_completed` lands.
   */
  readonly queued: true
}

/**
 * Queue first, then opportunistically run this exact job. If the request is
 * interrupted, the cron route reclaims the durable job; the deterministic R2
 * key prevents a second paid generation after a stored result.
 */
export async function redoPromptPreviewAction(
  intakeFileId: string,
): Promise<ActionResult<{ promptText: string; model: string }>> {
  return withOperator(async (operator) => {
    const { prepareImageRedo, previewRedoPrompt } = await import(
      '@/lib/enhance/redo-server'
    )
    await prepareImageRedo(intakeFileId, operator.email)
    return previewRedoPrompt(intakeFileId)
  })
}

/**
 * Permanently removes only an ungrouped queue photograph. The database claim
 * runs first and wins the grouping race; grouped, published, or historically
 * Shopify-sent photographs are refused before Drive or R2 is touched.
 */
export async function deleteUngroupedPhotoAction(
  intakeFileId: string,
): Promise<ActionResult<{ intakeFileId: string }>> {
  return withOperator(async (operator) => {
    const db = (await import('@/lib/supabase/server')).supabaseServer()
    const { error } = await db.rpc('prepare_console_photo_delete', {
      p_intake_file_id: intakeFileId,
      p_actor: operator.email,
    })
    if (error) {
      throw new ConsoleError(
        error.hint || 'That photograph cannot be deleted from the console.',
        [error.code, error.message].filter(Boolean).join(' · '),
        error.code === '55000',
      )
    }

    const { discardHeldIntake } = await import('@/lib/tracking/discard')
    try {
      await discardHeldIntake(intakeFileId, operator.email)
    } catch (cause) {
      throw new ConsoleError(
        'The photograph could not be fully deleted. Open Tracking and press Discard to finish it.',
        cause instanceof Error ? cause.message : String(cause),
        true,
      )
    }
    // No queue snapshot: the client removes the tile optimistically and deletes
    // run in parallel; a snapshot per delete re-signed the whole grid each time.
    return { intakeFileId }
  })
}

export async function redoImageAction(
  intakeFileId: string,
  promptOverride?: string | null,
): Promise<ActionResult<RedoImageResult>> {
  return withOperator(async (operator) => {
    const { queueImageRedo, runProductionRedoBatch } = await import(
      '@/lib/enhance/redo-server'
    )
    const jobId = await queueImageRedo(intakeFileId, operator.email, promptOverride)

    /**
     * The paid generation takes ~70 s. Awaiting it here held the operator on a
     * frozen "Generating…" dialog for the whole call. `after` runs the exact
     * same batch once the response has been sent, so execution and interruption
     * semantics are unchanged — the job is durable, and the cron reclaims it if
     * this invocation is cut short (D52). Only the response moves earlier.
     *
     * Errors are swallowed deliberately: the redo worker persists its own
     * failure onto the job row, which the console renders as a failed badge. An
     * unhandled rejection here would add noise without adding information.
     */
    after(async () => {
      await runProductionRedoBatch(jobId).catch(() => undefined)
    })

    const [photo] = await loadPhotos([intakeFileId])
    if (!photo) throw new ConsoleError('That photograph no longer exists.', null, false)
    return { photo, jobId, queued: true }
  })
}

/**
 * Signed 1280px preview for a Drive-sourced original, generated on first
 * request (see original-preview.ts). Called when the operator switches a
 * photograph to its "orig" version and the row predates original thumbnails.
 */
export async function originalPreviewAction(
  intakeFileId: string,
): Promise<ActionResult<{ imageVersionId: string; thumbUrl: string }>> {
  return withOperator(async () => {
    const { ensureOriginalPreview } = await import('@/lib/console/original-preview')
    const preview = await ensureOriginalPreview(intakeFileId)
    return { imageVersionId: preview.imageVersionId, thumbUrl: preview.thumb.url }
  })
}

export async function colourSuggestionsAction(
  categoryId: string,
): Promise<ActionResult<readonly ColourSuggestion[]>> {
  return withOperator(() => loadColourSuggestions(categoryId))
}

export interface DraftBundle {
  readonly draft: DraftDetail
  readonly colours: readonly ColourSuggestion[]
  readonly blocks: readonly PublishBlock[]
}

async function bundle(draftId: string, allowZeroStock: boolean): Promise<DraftBundle> {
  const draft = await loadDraft(draftId)
  if (!draft) throw new ConsoleError('That product draft no longer exists.', null, false)
  const [colours, blocks] = await Promise.all([
    loadColourSuggestions(draft.categoryId),
    describeBlocks(draftId, allowZeroStock),
  ])
  return { draft, colours, blocks }
}

export async function openDraftAction(
  draftId: string,
  allowZeroStock = false,
): Promise<ActionResult<DraftBundle>> {
  return withOperator(() => bundle(draftId, allowZeroStock))
}

export async function groupPhotosAction(
  categoryId: string,
  intakeFileIds: readonly string[],
): Promise<ActionResult<{ bundle: DraftBundle; queue: QueueSnapshot }>> {
  return withOperator(async (operator) => {
    const draftId = await createDraftFromPhotos(operator, categoryId, intakeFileIds)
    return { bundle: await bundle(draftId, false), queue: await loadQueue() }
  })
}

export async function detachPhotoAction(
  draftId: string,
  intakeFileId: string,
): Promise<ActionResult<{ bundle: DraftBundle; queue: QueueSnapshot }>> {
  return withOperator(async (operator) => {
    await detachPhoto(operator, draftId, intakeFileId)
    return { bundle: await bundle(draftId, false), queue: await loadQueue() }
  })
}

export interface SaveDraftRequest extends DraftSaveInput {
  readonly allowZeroStock: boolean
}

export async function saveDraftAction(
  request: SaveDraftRequest,
): Promise<ActionResult<{ bundle: DraftBundle }>> {
  return withOperator(async (operator) => {
    await saveDraft(operator, request)

    /**
     * D60 (supersedes D7): Save Draft also puts the product in Shopify with
     * status DRAFT, so an unfinished piece is visible to the team there rather
     * than only inside Loupe.
     *
     * The Shopify half runs after the response — the same `after` pattern the
     * redo path uses — because a full `productSet` round trip inside the click
     * froze the console for seconds per draft. The operator's typing is already
     * safely in Postgres; `pushDraftToShopifyInBackground` records the outcome
     * on the draft row and as live events, and the next save retries by the
     * same reserved handle (hard rule 2).
     */
    after(async () => {
      await pushDraftToShopifyInBackground(
        request.draftId,
        operator,
        request.allowZeroStock,
      ).catch(() => undefined)
    })

    return { bundle: await bundle(request.draftId, request.allowZeroStock) }
  })
}

/**
 * Persists what the operator has typed WITHOUT touching Shopify.
 *
 * Autosave uses this rather than `saveDraftAction`, which since D60 also pushes
 * a real product to Shopify and reserves a SKU. Doing that on a debounce timer
 * would create Shopify products from half-typed forms and burn SKU numbers on
 * every pause in typing. Autosave protects the operator's work; "Save draft"
 * remains the deliberate act that puts the product in Shopify.
 */
export async function autosaveDraftAction(
  request: SaveDraftRequest,
): Promise<ActionResult<{ bundle: DraftBundle }>> {
  return withOperator(async (operator) => {
    await saveDraft(operator, request)
    return { bundle: await bundle(request.draftId, request.allowZeroStock) }
  })
}

export interface PublishSummary {
  readonly sku: string
  readonly title: string
  readonly handle: string
  readonly shopifyProductId: string
  readonly shopifyStatus: string | null
  readonly reusedIdentity: boolean
  readonly imageCount: number
  readonly altTexts: readonly { readonly mediaId: string; readonly alt: string | null }[]
  readonly housekeeping: readonly DriveHousekeepingOutcome[]
  /**
   * The sales channels the product went live on. Shown because the operator's
   * previous job was to open Shopify and tick these by hand; seeing them named
   * in the console is what tells them the trip is no longer needed.
   */
  readonly salesChannels: readonly string[]
}

export async function publishDraftAction(
  request: SaveDraftRequest,
): Promise<ActionResult<{ summary: PublishSummary; bundle: DraftBundle; queue: QueueSnapshot }>> {
  return withOperator(async (operator) => {
    // Save first, in the same click. Publishing what is on screen while the
    // database holds something older is the one way a "what you see is what you
    // published" preview can lie.
    await saveDraft(operator, request)

    const published = await publishDraftForOperator(request.draftId, operator, {
      allowZeroStock: request.allowZeroStock,
    })

    return {
      summary: {
        sku: published.result.sku,
        title: published.result.title,
        handle: published.result.handle,
        shopifyProductId: published.result.shopifyProductId,
        shopifyStatus: published.shopifyStatus,
        reusedIdentity: published.result.reusedIdentity,
        imageCount: published.media.length,
        altTexts: published.media.map((m) => ({ mediaId: m.id, alt: m.alt })),
        housekeeping: published.housekeeping,
        salesChannels: published.result.salesChannels.map((channel) => channel.name),
      },
      bundle: await bundle(request.draftId, request.allowZeroStock),
      queue: await loadQueue(),
    }
  })
}
