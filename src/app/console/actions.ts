'use server'

import { NotAuthorisedError, requireOperatorForAction } from '@/lib/auth/authorize'
import { ConsoleError, createDraftFromPhotos, detachPhoto, saveDraft, type DraftSaveInput } from '@/lib/console/mutations'
import {
  describeBlocks,
  publishDraftForOperator,
  PublishInProgressError,
  type DriveHousekeepingOutcome,
} from '@/lib/console/publish'
import {
  loadColourSuggestions,
  loadDraft,
  loadPhotos,
  loadPipelineActivity,
  loadQueue,
} from '@/lib/console/queue'
import type {
  ColourSuggestion,
  DraftDetail,
  PhotoSummary,
  PipelineActivity,
  QueueSnapshot,
} from '@/lib/console/types'
import { PublishBlockedError, type PublishBlock } from '@/lib/publish/validate'

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
  readonly completed: boolean
  readonly paidCalls: number
}

/**
 * Queue first, then opportunistically run this exact job. If the request is
 * interrupted, the cron route reclaims the durable job; the deterministic R2
 * key prevents a second paid generation after a stored result.
 */
export async function redoImageAction(
  intakeFileId: string,
): Promise<ActionResult<RedoImageResult>> {
  return withOperator(async (operator) => {
    const { queueImageRedo, runProductionRedoBatch } = await import(
      '@/lib/enhance/redo-server'
    )
    const jobId = await queueImageRedo(intakeFileId, operator.email)
    const result = await runProductionRedoBatch(jobId)
    const [photo] = await loadPhotos([intakeFileId])
    if (!photo) throw new ConsoleError('That photograph no longer exists.', null, false)
    return {
      photo,
      jobId,
      completed: result.completed === 1,
      paidCalls: result.paidCalls,
    }
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
): Promise<
  ActionResult<{
    bundle: DraftBundle
    queue: QueueSnapshot
    /** Set when the draft saved locally but could not reach Shopify (D60). */
    shopifyDraftError: string | null
  }>
> {
  return withOperator(async (operator) => {
    await saveDraft(operator, request)

    /**
     * D60 (supersedes D7): Save Draft now puts the product in Shopify with
     * status DRAFT, so an unfinished piece is visible to the team there rather
     * than only inside Loupe.
     *
     * Two things this deliberately does NOT do. It does not mark the Loupe
     * draft published — it is still the operator's to finish. And it does not
     * fail the save when Shopify is unreachable: the operator's typing is
     * already safely in Postgres by this point, and losing that because a
     * third-party API blinked would be a far worse outcome than a draft that
     * has not reached Shopify yet. The failure is reported, not swallowed, and
     * the next save retries by the same reserved handle (hard rule 2).
     */
    let shopifyDraftError: string | null = null
    try {
      await publishDraftForOperator(request.draftId, operator, {
        allowZeroStock: request.allowZeroStock,
        shopifyStatus: 'DRAFT',
      })
    } catch (error) {
      if (error instanceof PublishInProgressError) throw error
      shopifyDraftError =
        error instanceof Error ? error.message : 'The draft could not be sent to Shopify.'
    }

    return {
      bundle: await bundle(request.draftId, request.allowZeroStock),
      queue: await loadQueue(),
      shopifyDraftError,
    }
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
      },
      bundle: await bundle(request.draftId, request.allowZeroStock),
      queue: await loadQueue(),
    }
  })
}
