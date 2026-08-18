'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  autosaveDraftAction,
  beginManualUploadAction,
  changeDraftCategoryAction,
  colourSuggestionsAction,
  deleteUngroupedPhotoAction,
  detachPhotoAction,
  groupPhotosAction,
  openDraftAction,
  previewPhotosAction,
  publishDraftAction,
  redoImageAction,
  originalPreviewAction,
  redoPromptPreviewAction,
  refreshQueueAction,
  saveDraftAction,
  finalizeManualUploadAction,
  type ActionError,
  type ActionResult,
  type DraftBundle,
  type PublishSummary,
} from '@/app/(shell)/console/actions'
import { parseRupeesToPaise } from '@/lib/console/money'
import { predictIdentity, type PredictedIdentity } from '@/lib/console/preview'
import {
  preserveThumbs,
  QUEUE_VIEW_LABELS,
  tilesForQueueView,
  type QueueView,
} from '@/lib/console/queue-view'
import type {
  CategoryOption,
  ColourSuggestion,
  ConsoleCatalog,
  PhotoSummary,
  QueueSnapshot,
} from '@/lib/console/types'
import {
  LIVE_ACTIVITY_EVENT,
  shouldRefreshConsole,
  type LiveActivityUpdate,
} from '@/lib/live/types'
import type { PublishBlock } from '@/lib/publish/validate'

import { putUploadedObject } from '@/components/upload/put-object'

import { DraftEditor, type EditorForm } from './DraftEditor'
import { NewCategoryDialog } from './NewCategoryDialog'
import { Card, Notice, StatPill } from './primitives'
import { QueueGrid } from './QueueGrid'
import { RedoPromptDialog } from './RedoPromptDialog'

/**
 * The console.
 *
 * WHAT THE BROWSER IS AND IS NOT ALLOWED TO BE
 *
 *   This component holds what the operator is typing. It does not hold the
 *   truth. Grouping, image assignment, order and every field are written through
 *   server actions into Postgres, and the identity preview is a PREDICTION that
 *   moves no counter. When the two disagree — a stale save, a photograph another
 *   operator grabbed first — the database wins and says so.
 *
 * STICKY DEFAULTS are the exception, and only in one direction: category,
 * material and one-stock quantity carry to the NEXT new product because a batch is a hundred
 * necklaces in a row. Price, options, suffix and images never carry — repeating
 * the previous product's price is how the wrong price goes out. And a saved
 * draft's own values always win: a sticky default is a starting point for
 * something new, never an overwrite of something stored.
 */

const STICKY_KEY = 'loupe.sticky.v1'
/** Presigned URLs live 15 minutes; refresh well inside that. */
const QUEUE_REFRESH_MS = 9 * 60 * 1000

export interface UploadItem {
  readonly key: string
  readonly name: string
  readonly progress: number
  readonly state: 'uploading' | 'done' | 'failed'
  readonly detail: string | null
}

interface Sticky {
  categoryId: string | null
  materialId: string | null
  customMaterial: string
  stock: string
}

function readSticky(): Sticky {
  if (typeof window === 'undefined') {
    return { categoryId: null, materialId: null, customMaterial: '', stock: '' }
  }
  try {
    const raw = window.localStorage.getItem(STICKY_KEY)
    if (!raw) return { categoryId: null, materialId: null, customMaterial: '', stock: '' }
    const parsed = JSON.parse(raw) as Partial<Sticky>
    return {
      categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId : null,
      materialId: typeof parsed.materialId === 'string' ? parsed.materialId : null,
      customMaterial:
        typeof parsed.customMaterial === 'string' ? parsed.customMaterial.slice(0, 100) : '',
      stock: typeof parsed.stock === 'string' ? parsed.stock : '',
    }
  } catch {
    return { categoryId: null, materialId: null, customMaterial: '', stock: '' }
  }
}

function writeSticky(sticky: Sticky): void {
  try {
    window.localStorage.setItem(STICKY_KEY, JSON.stringify(sticky))
  } catch {
    /* Private browsing, quota, a locked-down profile — never worth an error. */
  }
}

const EMPTY_FORM: EditorForm = {
  categoryId: null,
  materialId: null,
  customMaterial: '',
  descriptionOverride: null,
  price: '',
  stock: '',
  variantKind: 'none',
  variants: [],
  weight: '',
  titleSuffix: '',
  images: [],
  allowZeroStock: false,
}

/** The version the pipeline picked, else the newest. Same rule as the SQL side. */
function defaultVersionId(photo: PhotoSummary): string | null {
  const chosen = [...photo.versions].sort(
    (a, b) => Number(b.isSelected) - Number(a.isSelected) || b.versionNo - a.versionNo,
  )[0]
  return chosen?.id ?? null
}

/**
 * A server action that cannot reject.
 *
 * Server-side every action already returns `{ ok: false }` with a sentence
 * written for the operator (actions.ts · toActionError). A REJECTION is the
 * other failure and nothing was catching it: the POST itself never completed —
 * offline, timed out, or a redeploy invalidated the generated action id. That
 * threw straight past `handleResult`, so no error appeared and the saving
 * spinner never cleared, while `ensureDraft` had already grouped the
 * photographs and moved them out of Pending. The result was a draft tile that
 * looked finished with nothing in Shopify and nothing in `product_drafts`
 * beyond the row itself.
 *
 * Vague about the cause, specific about the consequence, for the same reason
 * `toActionError` is: an unknown failure must never imply the work was saved.
 */
async function settled<T>(call: Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await call
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: 'error',
        message:
          'The console could not reach the server, so nothing was saved. Check the connection, reload the page and try again.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        blocks: [],
      },
    }
  }
}

function formFromBundle(bundle: DraftBundle): EditorForm {
  const draft = bundle.draft
  return {
    categoryId: draft.categoryId,
    materialId: draft.materialId,
    customMaterial: draft.customMaterial ?? '',
    descriptionOverride: draft.descriptionOverride,
    price: draft.pricePaise === null ? '' : formatRupees(draft.pricePaise),
    stock: String(draft.stock),
    variantKind: draft.variantKind,
    variants: [...draft.variants]
      .sort((a, b) => a.position - b.position)
      .map((variant) => ({ value: variant.value, stock: String(variant.stock) })),
    // NULL is "nobody has said" and is NOT the same as 0 (D19), so an unset
    // weight stays an empty field rather than becoming a typed zero.
    weight: draft.weightG === null ? '' : String(draft.weightG),
    titleSuffix: draft.titleSuffix ?? '',
    images: [...draft.images]
      .sort((a, b) => a.position - b.position)
      .map((image) => ({
        intakeFileId: image.intakeFileId,
        imageVersionId: image.imageVersionId,
        colourValue: image.colourValue,
      })),
    allowZeroStock: false,
  }
}

function formatRupees(paise: number): string {
  const rupees = Math.trunc(paise / 100)
  const fraction = paise % 100
  return fraction === 0 ? String(rupees) : `${rupees}.${String(fraction).padStart(2, '0')}`
}

export interface ConsoleScreenProps {
  readonly initialQueue: QueueSnapshot
  readonly catalog: ConsoleCatalog
  readonly initialBundle: DraftBundle | null
}

export function ConsoleScreen({
  initialQueue,
  catalog,
  initialBundle,
}: ConsoleScreenProps) {
  const [queue, setQueue] = useState(initialQueue)
  const [activity, setActivity] = useState(initialQueue.pipelineActivity)
  /** The redo awaiting prompt review. Null when no dialog is open. */
  const [redoReview, setRedoReview] = useState<{
    intakeFileId: string
    filename: string
    promptText: string | null
    model: string | null
  } | null>(null)
  const [bundle, setBundle] = useState<DraftBundle | null>(initialBundle)
  const [categories, setCategories] = useState<readonly CategoryOption[]>(catalog.categories)
  const [addingCategory, setAddingCategory] = useState(false)
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<readonly string[]>([])
  // Keyed by the selection it belongs to, so a stale preview is never rendered
  // and no effect has to synchronously clear it.
  const [preview, setPreview] = useState<{ key: string; photos: readonly PhotoSummary[] }>({
    key: '',
    photos: [],
  })
  const [colours, setColours] = useState<readonly ColourSuggestion[]>(initialBundle?.colours ?? [])
  const [form, setForm] = useState<EditorForm>(initialBundle ? formFromBundle(initialBundle) : EMPTY_FORM)
  const [savedForm, setSavedForm] = useState<EditorForm | null>(
    initialBundle ? formFromBundle(initialBundle) : null,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ActionError | null>(null)
  const [lastPublish, setLastPublish] = useState<PublishSummary | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [queueView, setQueueView] = useState<QueueView>('pending')
  /**
   * Long-running work is scoped to what it touches instead of one global
   * `busy` slot. A draft being pushed, three photographs being deleted and a
   * batch of uploads can all be in flight while the operator keeps selecting
   * and typing — the old single slot froze the whole console per operation.
   */
  const [savingDraftIds, setSavingDraftIds] = useState<ReadonlySet<string>>(new Set())
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set())
  const [uploads, setUploads] = useState<readonly UploadItem[]>([])
  /** Backfilled 1280px previews for Drive originals, by image version id. */
  const [originalPreviews, setOriginalPreviews] = useState<Record<string, string>>({})

  const priceRef = useRef<HTMLInputElement>(null)
  const manualUploadRef = useRef<HTMLInputElement>(null)
  /** Latest editor context, readable from background completions without stale closures. */
  const activeDraftIdRef = useRef<string | null>(null)
  const formRef = useRef<EditorForm | null>(null)
  const requestedPreviewsRef = useRef(new Set<string>())
  const queueRefreshTimerRef = useRef<number | null>(null)
  const tileRefs = useRef(new Map<number, HTMLButtonElement>())
  const registerTile = useCallback((index: number, node: HTMLButtonElement | null) => {
    if (node) tileRefs.current.set(index, node)
    else tileRefs.current.delete(index)
  }, [])

  const mode: 'empty' | 'new' | 'draft' = bundle
    ? 'draft'
    : selectedPhotoIds.length > 0
      ? 'new'
      : 'empty'
  const selectionKey = selectedPhotoIds.join(',')
  const draftPhotos = bundle?.draft.photos
  const photos = useMemo(() => {
    if (mode === 'draft') return draftPhotos ?? []
    return preview.key === selectionKey ? preview.photos : []
  }, [mode, draftPhotos, preview, selectionKey])
  const visibleTiles = useMemo(() => tilesForQueueView(queue, queueView), [queue, queueView])
  const listedReadOnly = bundle?.draft.status === 'published'

  const { uploading, processing } = activity
  const pipelineBusy = uploading + processing > 0

  const refreshQueue = useCallback(async () => {
    const result = await settled(refreshQueueAction())
    if (!result.ok) return
    setQueue((current) => preserveThumbs(current, result.data.queue))
    // Counters move under this page — every Save draft reserves the next
    // number inside the save request (D107), and a webhook raises it when
    // somebody creates a product in Shopify admin. A stale `lastNumber` shows
    // the same predicted SKU on every draft of the session.
    setCategories(result.data.categories)
  }, [])

  /**
   * At most one queue re-read per 1.5s no matter how many background
   * completions land together — ten parallel uploads must not cost ten full
   * presigned snapshots.
   */
  const refreshQueueSoon = useCallback(() => {
    if (queueRefreshTimerRef.current !== null) return
    queueRefreshTimerRef.current = window.setTimeout(() => {
      queueRefreshTimerRef.current = null
      void refreshQueue()
    }, 1_500)
  }, [refreshQueue])

  /** Signed URLs expire on their own schedule, regardless of Drive activity. */
  useEffect(() => {
    const timer = window.setInterval(() => void refreshQueue(), QUEUE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refreshQueue])

  /**
   * The shared sidebar owns the one cheap site-wide heartbeat. Audit-event ids
   * cannot miss a complete enhancement between polls; this screen pays for a
   * full, image-signed queue read only when a transition changes the grid.
   */
  useEffect(() => {
    const onLiveActivity = (rawEvent: Event) => {
      const update = (rawEvent as CustomEvent<LiveActivityUpdate>).detail
      if (!update?.snapshot) return
      setActivity({
        uploading: update.snapshot.queued,
        processing: update.snapshot.enhancing,
      })
      if (shouldRefreshConsole(update.snapshot.events)) void refreshQueue()
    }
    window.addEventListener(LIVE_ACTIVITY_EVENT, onLiveActivity)
    return () => window.removeEventListener(LIVE_ACTIVITY_EVENT, onLiveActivity)
  }, [refreshQueue])

  /** Versions and full images for photographs that are selected but not grouped. */
  useEffect(() => {
    if (mode !== 'new') return
    let cancelled = false
    void previewPhotosAction(selectionKey.split(',')).then((result) => {
      if (cancelled || !result.ok) return
      setPreview({ key: selectionKey, photos: result.data })
      setForm((current) => ({
        ...current,
        images: result.data
          .map((photo) => ({
            intakeFileId: photo.intakeFileId,
            imageVersionId: defaultVersionId(photo) ?? '',
            colourValue: null,
          }))
          .filter((image) => image.imageVersionId !== ''),
      }))
    })
    return () => {
      cancelled = true
    }
  }, [mode, selectionKey])

  /** Per-category colour ranking. Necklaces suggest Gold/Silver; Rings do not. */
  useEffect(() => {
    if (!form.categoryId || mode === 'empty') return
    let cancelled = false
    void colourSuggestionsAction(form.categoryId).then((result) => {
      if (!cancelled && result.ok) setColours(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [form.categoryId, mode])

  const category = categories.find((c) => c.id === form.categoryId) ?? null

  const identity: PredictedIdentity | null = useMemo(() => {
    if (!category) return null
    return predictIdentity({
      skuPrefix: category.skuPrefix,
      titlePattern: category.titlePattern,
      lastNumber: category.lastNumber,
      titleSuffix: form.titleSuffix.trim() || null,
      reservedSku: bundle?.draft.reservedSku ?? null,
      reservedHandle: bundle?.draft.reservedHandle ?? null,
    })
  }, [category, form.titleSuffix, bundle?.draft.reservedSku, bundle?.draft.reservedHandle])

  /**
   * Blocks shown while typing come from the server for a saved draft, and are
   * derived locally for a product that does not exist yet — the SAME rules, but
   * a draft has to exist before the server can check it. The server decides at
   * publish either way; nothing here can let a blocked draft through.
   */
  const blocks: readonly PublishBlock[] = useMemo(
    () => (mode === 'draft' ? (bundle?.blocks ?? []) : localBlocks(form, category)),
    [mode, bundle?.blocks, form, category],
  )

  const dirty = savedForm === null || JSON.stringify(savedForm) !== JSON.stringify(form)

  useEffect(() => {
    activeDraftIdRef.current = bundle?.draft.id ?? null
  }, [bundle?.draft.id])
  useEffect(() => {
    formRef.current = form
  }, [form])

  const updateForm = useCallback((patch: Partial<EditorForm>) => {
    setForm((current) => ({ ...current, ...patch }))
    setError(null)
  }, [])

  const applyBundle = useCallback((next: DraftBundle) => {
    setBundle(next)
    setColours(next.colours)
    const nextForm = formFromBundle(next)
    setForm(nextForm)
    setSavedForm(nextForm)
    setSelectedPhotoIds([])
  }, [])

  const handleResult = useCallback(
    <T,>(result: ActionResult<T>): T | null => {
      if (result.ok) {
        setError(null)
        return result.data
      }
      setError(result.error)
      return null
    },
    [],
  )

  /**
   * Sticky defaults seed a NEW product, in the click that starts it.
   *
   * In an event handler rather than an effect on purpose: an effect would have
   * to guess whether the form it is looking at is "still the old product" and
   * could overwrite something the operator had already typed.
   */
  const seededForm = useCallback((): EditorForm => {
    const sticky = readSticky()
    const stickyCategory = categories.find((c) => c.id === sticky.categoryId) ?? null
    return {
      ...EMPTY_FORM,
      categoryId: stickyCategory?.id ?? null,
      materialId: sticky.materialId ?? null,
      customMaterial: sticky.customMaterial,
      stock: sticky.stock || String(stickyCategory?.defaultStock ?? 0),
    }
  }, [categories])

  const togglePhoto = useCallback(
    (intakeFileId: string) => {
      // Starting a product from scratch: leaving an open draft, or beginning a
      // fresh selection. Adding a second photograph to the same product keeps
      // whatever has already been typed.
      const startingFresh = bundle !== null || selectedPhotoIds.length === 0
      setLastPublish(null)
      setBundle(null)
      setSavedForm(null)
      if (startingFresh) setForm(seededForm())
      setSelectedPhotoIds((current) =>
        current.includes(intakeFileId)
          ? current.filter((id) => id !== intakeFileId)
          : [...current, intakeFileId],
      )
      // "Selecting a queue tile focuses the price input" — the whole point is
      // that the operator's hands never leave the keyboard between products.
      window.setTimeout(() => priceRef.current?.focus(), 0)
    },
    [bundle, seededForm, selectedPhotoIds.length],
  )

  /** D101: correct a reserved draft's category — frees the number, new sequence next Draft. */
  const handleChangeCategoryLocked = useCallback(
    async (categoryId: string) => {
      if (!bundle) return
      const target = categories.find((option) => option.id === categoryId)
      const confirmed = window.confirm(
        `Change category to ${target?.name ?? 'the selected category'}?\n\n` +
          `• ${bundle.draft.reservedSku ?? 'The reserved number'} is freed — the next draft in its old category will use it.\n` +
          '• The Shopify draft product (if any) is deleted.\n' +
          `• The next Draft or Publish assigns a fresh ${target?.skuPrefix ?? ''} number.\n\n` +
          'Published products are never touched.',
      )
      if (!confirmed) return
      setBusy('open')
      const result = await changeDraftCategoryAction(bundle.draft.id, categoryId)
      if (result.ok) {
        applyBundle(result.data.bundle)
        void refreshQueue()
      } else {
        handleResult(result)
      }
      setBusy(null)
    },
    [applyBundle, bundle, categories, handleResult, refreshQueue],
  )

  const openDraft = useCallback(
    async (draftId: string) => {
      setBusy('open')
      setLastPublish(null)
      setSelectedPhotoIds([])
      const data = handleResult(await openDraftAction(draftId))
      if (data) applyBundle(data)
      setBusy(null)
    },
    [applyBundle, handleResult],
  )

  /** Creates the draft if the operator is still working from a raw selection. */
  const ensureDraft = useCallback(async (): Promise<DraftBundle | null> => {
    if (bundle) return bundle
    if (!form.categoryId) {
      setError({
        kind: 'blocked',
        message: 'Choose a category first — it decides the SKU sequence, the title and the collection.',
        detail: null,
        retryable: true,
        blocks: [],
      })
      return null
    }
    const data = handleResult(await settled(groupPhotosAction(form.categoryId, selectedPhotoIds)))
    if (!data) return null
    setQueue(data.queue)
    setBundle(data.bundle)
    setColours(data.bundle.colours)
    // The form's image list normally arrives from the preview round trip,
    // which a fast operator can outrun. Grouping already recorded the
    // pipeline-chosen version of every photograph server-side, so a form that
    // still has no images adopts the server's list rather than continuing to
    // show — and save — an empty one (D107).
    setForm((current) =>
      current.images.length > 0
        ? current
        : { ...current, images: formFromBundle(data.bundle).images },
    )
    return data.bundle
  }, [bundle, form.categoryId, selectedPhotoIds, handleResult])

  const saveRequest = useCallback(
    (target: DraftBundle) => {
      const price = parseRupeesToPaise(form.price)
      const singleStock = Number.parseInt(form.stock.trim() || '0', 10)
      const variants = form.variants.map((variant) => {
        const stock = Number.parseInt(variant.stock.trim() || '0', 10)
        return { value: variant.value, stock: Number.isFinite(stock) ? stock : 0 }
      })
      const stock =
        form.variantKind === 'none'
          ? singleStock
          : variants.reduce((total, variant) => total + Math.max(0, variant.stock), 0)
      const weight = form.weight.trim()
      // Same race as ensureDraft's adoption, for the request itself: an empty
      // form list means the preview has not landed, while the bundle carries
      // the group-time selection. Send the bundle's images rather than an
      // empty list the operator never created. (The database refuses to treat
      // an empty list as removal either way — D107.)
      const images = form.images.length > 0 ? form.images : formFromBundle(target).images
      return {
        draftId: target.draft.id,
        expectedUpdatedAt: target.draft.updatedAt,
        categoryId: form.categoryId!,
        materialId: form.materialId,
        customMaterial: form.customMaterial.trim() || null,
        descriptionOverride: form.descriptionOverride?.trim() || null,
        titleSuffix: form.titleSuffix.trim() || null,
        pricePaise: price.ok ? price.paise : null,
        // Empty stays NULL: "nobody has said" is a real state and 0 g is a
        // different, deliberate one (D19). `??`-shaped, never `||`-shaped.
        weightG: weight === '' ? null : Number.parseInt(weight, 10),
        stock: Number.isFinite(stock) ? stock : 0,
        variantKind: form.variantKind,
        variants,
        images: images.map((image, index) => ({
          imageVersionId: image.imageVersionId,
          position: index,
          colourValue: form.variantKind === 'colour' ? image.colourValue : null,
        })),
        allowZeroStock: form.allowZeroStock,
      }
    },
    [form],
  )

  /**
   * Autosave: typing is never lost because somebody navigated away.
   *
   * Local only — it does NOT touch Shopify. Since D60 "Save draft" also pushes a
   * real product and reserves a SKU, so running that on a timer would create
   * Shopify products from half-typed forms and burn a SKU number on every pause.
   * Autosave protects the work; Save draft remains the deliberate act.
   *
   * It also only runs for a draft that already EXISTS. A selection that has not
   * been grouped yet has no draft row to write to, and silently creating one
   * would turn "I clicked a photograph" into a product the operator never asked
   * for.
   */
  useEffect(() => {
    if (!bundle || !dirty || busy !== null || listedReadOnly) return
    if (savingDraftIds.has(bundle.draft.id)) return
    const draftId = bundle.draft.id
    const timer = window.setTimeout(async () => {
      const result = await settled(autosaveDraftAction(saveRequest(bundle)))
      if (!result.ok) return // The operator keeps typing; Save draft reports properly.
      setSavedForm(formFromBundle(result.data.bundle))
      setBundle((current) =>
        current && current.draft.id === draftId
          ? { ...current, draft: result.data.bundle.draft, blocks: result.data.bundle.blocks }
          : current,
      )
    }, 1_500)
    return () => window.clearTimeout(timer)
  }, [bundle, busy, dirty, listedReadOnly, saveRequest, savingDraftIds])

  const rememberSticky = useCallback(() => {
    const previous = readSticky()
    writeSticky({
      categoryId: form.categoryId,
      materialId: form.materialId,
      customMaterial: form.customMaterial.trim(),
      // Per-choice totals are product-specific and should never seed the next
      // simple product. Preserve the last one-stock quantity instead.
      stock: form.variantKind === 'none' ? form.stock : previous.stock,
    })
  }, [
    form.categoryId,
    form.customMaterial,
    form.materialId,
    form.stock,
    form.variantKind,
  ])

  /**
   * "Draft" is near-instant now. The local save is the only awaited part; the
   * Shopify DRAFT push runs server-side after the response and reports back
   * through live events. The operator can select the next photograph the
   * moment the click lands — completion only touches the editor if they are
   * still looking at the same draft, and never overwrites newer typing.
   */
  const handleSaveDraft = useCallback(async () => {
    setLastPublish(null)
    const target = await ensureDraft()
    if (!target) return
    const draftId = target.draft.id
    const requestedForm = formRef.current
    setSavingDraftIds((current) => new Set(current).add(draftId))
    // The grid is free immediately: grouped photographs already left Pending
    // via ensureDraft's snapshot, and holding the selection highlight through
    // a background save made "click the next image" feel broken.
    setSelectedPhotoIds([])
    rememberSticky()

    const result = await settled(saveDraftAction(saveRequest(target)))
    setSavingDraftIds((current) => {
      const next = new Set(current)
      next.delete(draftId)
      return next
    })

    if (!result.ok) {
      // Surface the failure wherever the operator is now — the draft still
      // holds their typing locally if the save was a conflict.
      handleResult(result)
      return
    }

    const stillOnThisDraft = activeDraftIdRef.current === draftId
    if (stillOnThisDraft) {
      const untouchedSinceRequest = formRef.current === requestedForm
      if (untouchedSinceRequest) {
        setBundle(result.data.bundle)
        setColours(result.data.bundle.colours)
        const nextForm = formFromBundle(result.data.bundle)
        setForm(nextForm)
        setSavedForm(nextForm)
      } else {
        // Keep the newer typing; adopt only the server-side draft facts
        // (updatedAt for optimistic concurrency, blocks, reserved identity).
        setBundle(result.data.bundle)
        setSavedForm(formFromBundle(result.data.bundle))
      }
    }
    refreshQueueSoon()
  }, [ensureDraft, handleResult, refreshQueueSoon, rememberSticky, saveRequest])

  const focusNextUngrouped = useCallback((snapshot: QueueSnapshot) => {
    const nextPhoto = snapshot.tiles.find((tile) => tile.kind === 'photo')
    if (!nextPhoto) return
    setQueueView('ungrouped')
    setFocusIndex(0)
    window.setTimeout(() => {
      // The just-published tile still occupies its old numeric position until
      // React commits the updated queue. Resolve by stable photo id so focus
      // cannot fall onto whichever draft happens to inherit that index.
      const node = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-tile-kind="photo"]'),
      ).find((tile) => tile.dataset.tileId === nextPhoto.id)
      node?.focus()
    }, 0)
  }, [])

  const showQueueView = useCallback((view: QueueView) => {
    setQueueView(view)
    setFocusIndex(0)
  }, [])

  /**
   * Any number of files, three at a time, none of them blocking anything.
   * Each file runs its own begin → direct-to-R2 PUT → finalize; the queue is
   * refreshed once per burst rather than once per file. Failures stay in the
   * panel with their reason until dismissed — a silent partial upload is how
   * a catalogue loses photographs.
   */
  const handleManualUploads = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return
      setLastPublish(null)
      const items: UploadItem[] = files.map((file, index) => ({
        key: `${Date.now()}:${index}:${file.name}`,
        name: file.name,
        progress: 0,
        state: 'uploading',
        detail: null,
      }))
      setUploads((current) => [...current, ...items])
      const patchItem = (key: string, patch: Partial<UploadItem>) =>
        setUploads((current) =>
          current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
        )

      const work = files.map((file, index) => ({ file, item: items[index]! }))
      const pending = [...work]
      await Promise.all(
        Array.from({ length: Math.min(3, pending.length) }, async () => {
          for (;;) {
            const next = pending.shift()
            if (!next) return
            const { file, item } = next
            try {
              const ticketResult = await beginManualUploadAction({
                filename: file.name,
                mimeType: file.type,
                bytes: file.size,
              })
              if (!ticketResult.ok) {
                patchItem(item.key, { state: 'failed', detail: ticketResult.error.message })
                continue
              }
              const ticket = ticketResult.data
              await putUploadedObject(ticket.uploadUrl, file, ticket.contentType, (percent) =>
                patchItem(item.key, { progress: percent }),
              )
              const completed = await finalizeManualUploadAction(ticket.uploadId)
              if (!completed.ok) {
                patchItem(item.key, { state: 'failed', detail: completed.error.message })
                continue
              }
              patchItem(item.key, { state: 'done', progress: 100 })
              refreshQueueSoon()
            } catch (cause) {
              patchItem(item.key, {
                state: 'failed',
                detail: cause instanceof Error ? cause.message : String(cause),
              })
            }
          }
        }),
      )
      // Completed rows tidy themselves away; failures stay until dismissed.
      window.setTimeout(() => {
        setUploads((current) => current.filter((item) => item.state !== 'done'))
      }, 4_000)
    },
    [refreshQueueSoon],
  )

  const dismissUpload = useCallback((key: string) => {
    setUploads((current) => current.filter((item) => item.key !== key))
  }, [])

  const handlePublish = useCallback(async () => {
    setBusy('publish')
    setLastPublish(null)
    const target = await ensureDraft()
    if (!target) {
      setBusy(null)
      return
    }
    const data = handleResult(await settled(publishDraftAction(saveRequest(target))))
    if (data) {
      setQueue(data.queue)
      setLastPublish(data.summary)
      rememberSticky()
      setBundle(null)
      setSavedForm(null)
      setSelectedPhotoIds([])
      // Carry the batch forward: category, material and stock stay; the price
      // and everything specific to that piece are cleared.
      setForm(seededForm())
      focusNextUngrouped(data.queue)
    } else {
      // A failed publish keeps the draft open so the operator can fix and retry
      // onto the same reserved identity rather than rebuilding the product.
      const refreshed = await settled(openDraftAction(target.draft.id))
      if (refreshed.ok) {
        setBundle(refreshed.data)
        setColours(refreshed.data.colours)
      }
    }
    setBusy(null)
  }, [ensureDraft, focusNextUngrouped, handleResult, rememberSticky, saveRequest, seededForm])

  const handleDetach = useCallback(
    async (intakeFileId: string) => {
      if (!bundle) return
      setBusy('detach')
      const data = handleResult(await detachPhotoAction(bundle.draft.id, intakeFileId))
      if (data) {
        setQueue(data.queue)
        applyBundle(data.bundle)
      }
      setBusy(null)
    },
    [applyBundle, bundle, handleResult],
  )

  /**
   * Deletes are optimistic and parallel: the tile disappears on click, the
   * server call runs in the background, and a failure restores the truth with
   * one refreshed snapshot. Nothing else on screen is disabled while a delete
   * is in flight — the old single busy slot made a five-photo cleanup five
   * sequential waits.
   */
  const deletePhotos = useCallback(
    async (intakeFileIds: readonly string[]) => {
      const ids = intakeFileIds.filter((id) => !deletingIds.has(id))
      if (ids.length === 0) return
      const idSet = new Set(ids)
      setLastPublish(null)
      setDeletingIds((current) => new Set([...current, ...ids]))
      setQueue((current) => ({
        ...current,
        tiles: current.tiles.filter((tile) => !(tile.kind === 'photo' && idSet.has(tile.id))),
        ungroupedCount: Math.max(0, current.ungroupedCount - ids.length),
      }))
      setSelectedPhotoIds((current) => current.filter((id) => !idSet.has(id)))
      setForm((current) => ({
        ...current,
        images: current.images.filter((image) => !idSet.has(image.intakeFileId)),
      }))
      setFocusIndex((current) => Math.max(0, current - 1))

      // Bounded concurrency: enough to feel instant, never a stampede of
      // Drive/R2 cleanups.
      const queueOfIds = [...ids]
      let anyFailed = false
      await Promise.all(
        Array.from({ length: Math.min(4, queueOfIds.length) }, async () => {
          for (;;) {
            const id = queueOfIds.shift()
            if (!id) return
            const result = await deleteUngroupedPhotoAction(id)
            if (!result.ok) {
              anyFailed = true
              handleResult(result)
            }
            setDeletingIds((current) => {
              const next = new Set(current)
              next.delete(id)
              return next
            })
          }
        }),
      )
      if (anyFailed) {
        // The claim runs before external cleanup; a fresh snapshot honestly
        // restores anything that refused to delete, and Tracking exposes the
        // retryable Discard action for a partial cleanup.
        void refreshQueue()
      }
    },
    [deletingIds, handleResult, refreshQueue],
  )

  const handleDeletePhoto = useCallback(
    (intakeFileId: string, filename: string) => {
      const confirmed = window.confirm(
        `Delete ${filename}?\n\nThis permanently removes its stored images from Loupe. ` +
          'If it came from RAW, the source file is moved to /Discarded. ' +
          'Photographs already attached to a draft or sent to Shopify are refused.',
      )
      if (!confirmed) return
      void deletePhotos([intakeFileId])
    },
    [deletePhotos],
  )

  const handleDeleteSelected = useCallback(() => {
    if (selectedPhotoIds.length === 0) return
    const confirmed = window.confirm(
      `Delete ${selectedPhotoIds.length} selected photograph${
        selectedPhotoIds.length === 1 ? '' : 's'
      }?\n\nThis permanently removes their stored images from Loupe. ` +
        'Files from RAW are moved to /Discarded.',
    )
    if (!confirmed) return
    void deletePhotos(selectedPhotoIds)
  }, [deletePhotos, selectedPhotoIds])

  const moveImage = useCallback((imageVersionId: string, delta: number) => {
    setForm((current) => {
      const index = current.images.findIndex((i) => i.imageVersionId === imageVersionId)
      const next = index + delta
      if (index < 0 || next < 0 || next >= current.images.length) return current
      const images = [...current.images]
      const [moved] = images.splice(index, 1)
      images.splice(next, 0, moved)
      return { ...current, images }
    })
  }, [])

  /**
   * Backfill a display-sized preview whenever a Drive original (no thumb row)
   * becomes a selected version — covers both the "orig" chip click and a saved
   * draft that reopens with an original selected. Runs once per version; the
   * server stores the preview permanently.
   */
  useEffect(() => {
    for (const image of form.images) {
      const photo = photos.find((candidate) => candidate.intakeFileId === image.intakeFileId)
      const version = photo?.versions.find((candidate) => candidate.id === image.imageVersionId)
      if (!version || version.kind !== 'original' || version.thumb) continue
      if (originalPreviews[version.id] || requestedPreviewsRef.current.has(version.id)) continue
      requestedPreviewsRef.current.add(version.id)
      void originalPreviewAction(image.intakeFileId).then((result) => {
        if (result.ok) {
          setOriginalPreviews((current) => ({
            ...current,
            [result.data.imageVersionId]: result.data.thumbUrl,
          }))
        } else {
          requestedPreviewsRef.current.delete(version.id)
        }
      })
    }
  }, [photos, form.images, originalPreviews])

  const chooseVersion = useCallback((intakeFileId: string, imageVersionId: string) => {
    setForm((current) => ({
      ...current,
      images: current.images.map((image) =>
        image.intakeFileId === intakeFileId ? { ...image, imageVersionId } : image,
      ),
    }))
  }, [])

  /**
   * Redo is a paid call. Show the exact prompt first and let the operator edit
   * it for this product before anything is spent.
   */
  const openRedoReview = useCallback(
    async (intakeFileId: string, filename?: string) => {
      setRedoReview({
        intakeFileId,
        filename: filename ?? 'this photograph',
        promptText: null,
        model: null,
      })
      const result = await redoPromptPreviewAction(intakeFileId)
      if (!result.ok) {
        setRedoReview(null)
        handleResult(result)
        return
      }
      setRedoReview((current) =>
        current && current.intakeFileId === intakeFileId
          ? { ...current, promptText: result.data.promptText, model: result.data.model }
          : current,
      )
    },
    [handleResult],
  )

  const redoImage = useCallback(
    async (intakeFileId: string, promptOverride: string | null) => {
      setBusy(`redo:${intakeFileId}`)
      setLastPublish(null)
      const data = handleResult(await redoImageAction(intakeFileId, promptOverride))
      if (data) {
        setPreview((current) => ({
          ...current,
          photos: current.photos.map((photo) =>
            photo.intakeFileId === intakeFileId ? data.photo : photo,
          ),
        }))
        setBundle((current) =>
          current
            ? {
                ...current,
                draft: {
                  ...current.draft,
                  photos: current.draft.photos.map((photo) =>
                    photo.intakeFileId === intakeFileId ? data.photo : photo,
                  ),
                },
              }
            : current,
        )
      }
      setBusy(null)
    },
    [handleResult],
  )

  /** Escape abandons a selection without touching anything stored. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (selectedPhotoIds.length > 0) {
        setSelectedPhotoIds([])
        setForm(EMPTY_FORM)
      }
      setError(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedPhotoIds.length])

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Kolkata',
  })

  return (
    <main className="flex min-h-0 min-w-0 flex-col gap-3.5">
      {addingCategory ? (
        <NewCategoryDialog
          onCancel={() => setAddingCategory(false)}
          onCreated={(created) => {
            setCategories((current) => [...current, created])
            updateForm({
              categoryId: created.id,
              stock: String(created.defaultStock),
              weight: '',
            })
            setAddingCategory(false)
          }}
        />
      ) : null}

      {redoReview ? (
        <RedoPromptDialog
          filename={redoReview.filename}
          promptText={redoReview.promptText}
          model={redoReview.model}
          busy={busy === `redo:${redoReview.intakeFileId}`}
          onCancel={() => setRedoReview(null)}
          onContinue={(promptOverride) => {
            const target = redoReview.intakeFileId
            void redoImage(target, promptOverride).then(() => setRedoReview(null))
          }}
        />
      ) : null}

      <div className="flex items-center gap-3">
          <div>
            <h1 className="text-[26px] font-medium tracking-[-0.025em]">Console</h1>
            <div className="text-[12px] text-muted-foreground">{today}</div>
          </div>
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <StatPill
              value={queue.ungroupedCount}
              label="pending"
              selected={queueView === 'pending' || queueView === 'ungrouped'}
              onClick={() => showQueueView('pending')}
            />
            <StatPill
              value={queue.publishedToday}
              label="listed today"
              selected={queueView === 'listed'}
              onClick={() => showQueueView('listed')}
            />
            {queue.attentionCount > 0 ? (
              <StatPill
                value={queue.attentionCount}
                label="need attention"
                attention
                selected={queueView === 'attention'}
                onClick={() => showQueueView('attention')}
              />
            ) : null}
            <StatPill
              value={queue.draftCount}
              label="drafts"
              selected={queueView === 'drafts'}
              onClick={() => showQueueView('drafts')}
            />
          </div>
        </div>

        {uploads.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-panel bg-surface p-3" role="status" aria-live="polite">
            {uploads.map((item) => (
              <div key={item.key} className="flex items-center gap-2.5 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{item.name}</span>
                {item.state === 'uploading' ? (
                  <span className="relative h-1.5 w-32 overflow-hidden rounded-pill bg-chip">
                    <span
                      className="absolute inset-y-0 left-0 rounded-pill bg-ink transition-[width] duration-200"
                      style={{ width: `${item.progress}%` }}
                    />
                  </span>
                ) : null}
                {item.state === 'uploading' ? (
                  <span className="w-9 text-right tabular-nums text-muted-foreground">{item.progress}%</span>
                ) : item.state === 'done' ? (
                  <span className="text-green">✓ added to Pending</span>
                ) : (
                  <span className="text-amber" title={item.detail ?? undefined}>
                    failed{item.detail ? ` · ${item.detail}` : ''}
                  </span>
                )}
                {item.state !== 'uploading' ? (
                  <button
                    type="button"
                    aria-label={`Dismiss ${item.name}`}
                    onClick={() => dismissUpload(item.key)}
                    className="grid size-5 place-items-center rounded-full bg-chip text-[10px] text-ink-soft hover:bg-[#e6e6e6]"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {queue.truncated ? (
          <div className="rounded-pill bg-[#faf4e9] px-4 py-2 text-[12px] text-amber" role="status">
            The queue is showing only part of the outstanding work. Publish or clear some of it
            to see the rest.
          </div>
        ) : null}

        {pipelineBusy ? (
          <div
            className="flex items-center gap-2 rounded-pill bg-chip px-4 py-2 text-[12px] text-ink-soft"
            role="status"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-ink-soft" aria-hidden />
            {uploading > 0 ? (
              <span>
                <b className="font-semibold text-ink">{uploading}</b>{' '}
                {uploading === 1 ? 'photo' : 'photos'} queued
              </span>
            ) : null}
            {uploading > 0 && processing > 0 ? <span className="text-muted-foreground">·</span> : null}
            {processing > 0 ? (
              <span>
                <b className="font-semibold text-ink">{processing}</b>{' '}
                {processing === 1 ? 'photo' : 'photos'} enhancing
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_clamp(400px,32vw,500px)] gap-3.5 overflow-hidden">
          <Card className="flex min-h-0 flex-col">
            <div className="mb-4 flex items-center gap-2.5">
              <h2 className="text-[14px] font-medium">{QUEUE_VIEW_LABELS[queueView]}</h2>
              <span className="rounded-pill bg-chip px-2.5 py-0.5 text-[11px] text-muted-foreground">
                {visibleTiles.length}
              </span>
              {selectedPhotoIds.length > 0 ? (
                <span className="rounded-pill bg-ink px-2.5 py-1 text-[11px] font-medium text-white">
                  {selectedPhotoIds.length} selected · Esc to clear
                </span>
              ) : null}
              {mode === 'new' && selectedPhotoIds.length > 0 ? (
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  className="rounded-pill px-2.5 py-1 text-[11px] font-medium text-amber transition-colors hover:bg-[#faf4e9]"
                >
                  Delete {selectedPhotoIds.length} selected
                </button>
              ) : null}
              <input
                ref={manualUploadRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  event.target.value = ''
                  if (files.length > 0) void handleManualUploads(files)
                }}
              />
              <button
                type="button"
                onClick={() => manualUploadRef.current?.click()}
                title="Upload catalogue-ready JPEGs, PNGs or WebPs without running AI enhancement — pick as many as you like"
                className="ml-auto rounded-pill bg-ink px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[#242428]"
              >
                {uploads.some((item) => item.state === 'uploading')
                  ? `Uploading ${uploads.filter((item) => item.state === 'uploading').length}…`
                  : 'Upload images'}
              </button>
              <button
                type="button"
                onClick={() => void refreshQueue()}
                className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-[#ebebeb]"
              >
                Refresh
              </button>
            </div>

            <QueueGrid
              tiles={visibleTiles}
              selectedPhotoIds={new Set(selectedPhotoIds)}
              openDraftId={bundle?.draft.id ?? null}
              onTogglePhoto={togglePhoto}
              onOpenDraft={(draftId) => void openDraft(draftId)}
              focusIndex={focusIndex}
              onFocusIndexChange={setFocusIndex}
              registerTile={registerTile}
              ariaLabel={`${QUEUE_VIEW_LABELS[queueView]} products`}
              emptyMessage={
                queueView === 'listed'
                  ? 'Nothing has been listed today.'
                  : queueView === 'drafts'
                    ? 'There are no saved drafts.'
                    : queueView === 'attention'
                      ? 'Nothing needs attention.'
                      : queueView === 'ungrouped'
                        ? 'There are no ungrouped photographs.'
                        : 'Nothing is waiting. Enhanced photographs appear here as the worker finishes them.'
              }
            />
          </Card>

          <Card className="flex min-h-0 flex-col">
            <DraftEditor
              mode={mode}
              photos={photos}
              form={form}
              onChange={updateForm}
              categories={categories}
              materials={catalog.materials}
              colourSuggestions={colours}
              identity={identity}
              identityLocked={Boolean(bundle?.draft.reservedSku)}
              readOnly={listedReadOnly}
              blocks={blocks}
              busy={busy}
              savingDraft={
                bundle ? savingDraftIds.has(bundle.draft.id) : savingDraftIds.size > 0
              }
              deletingIds={deletingIds}
              originalPreviews={originalPreviews}
              dirty={dirty}
              priceRef={priceRef}
              onPublish={() => void handlePublish()}
              onSaveDraft={() => void handleSaveDraft()}
              onDetach={bundle && !listedReadOnly ? (id) => void handleDetach(id) : null}
              onMoveImage={moveImage}
              onChooseVersion={chooseVersion}
              onRedo={(intakeFileId, filename) => void openRedoReview(intakeFileId, filename)}
              onAddCategory={() => setAddingCategory(true)}
              onChangeCategoryLocked={
                bundle && !listedReadOnly && bundle.draft.status !== 'publishing'
                  ? (categoryId) => void handleChangeCategoryLocked(categoryId)
                  : null
              }
              onDeletePhoto={mode === 'new' ? handleDeletePhoto : null}
            >
              <div className="mt-3 flex flex-col gap-2">
                {error ? (
                  <Notice
                    tone="attention"
                    title={errorTitle(error)}
                    detail={error.detail}
                  >
                    {error.message}
                  </Notice>
                ) : null}

                {bundle?.draft.status === 'failed' && bundle.draft.error ? (
                  <Notice
                    tone="attention"
                    title="The last publish failed. Nothing was lost."
                    detail={bundle.draft.error}
                  >
                    This draft still holds {bundle.draft.reservedSku} and its handle, so
                    pressing Publish again repairs the same Shopify product rather than
                    creating a second one.
                  </Notice>
                ) : null}

                {lastPublish ? <PublishedNotice summary={lastPublish} /> : null}
              </div>
            </DraftEditor>
          </Card>
        </div>
    </main>
  )
}

function errorTitle(error: ActionError): string {
  switch (error.kind) {
    case 'auth':
      return 'Signed out'
    case 'blocked':
      return 'Not ready to publish — nothing was sent to Shopify'
    case 'conflict':
      return 'Someone got there first'
    default:
      return 'That did not work'
  }
}

function PublishedNotice({ summary }: { summary: PublishSummary }) {
  const failedMoves = summary.housekeeping.filter((h) => !h.ok)
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="plain" title={`Published · ${summary.sku}`}>
        <span className="font-mono text-[11.5px]">/products/{summary.handle}</span> ·{' '}
        {summary.imageCount} {summary.imageCount === 1 ? 'image' : 'images'} ·{' '}
        {summary.shopifyStatus?.toLowerCase() ?? 'live'}
        {summary.reusedIdentity ? ' · repaired the existing product' : ''}
      </Notice>
      {summary.salesChannels.length > 0 ? (
        <Notice tone="plain" title={`Live on ${summary.salesChannels.length} sales channels`}>
          {summary.salesChannels.join(' · ')}
        </Notice>
      ) : (
        <Notice tone="attention" title="Published, but the store has no active sales channel">
          Nothing was refused — there is simply nothing to publish to. Add a sales channel in
          Shopify admin, then republish this draft to put it in front of buyers.
        </Notice>
      )}
      {failedMoves.length > 0 ? (
        <Notice
          tone="attention"
          title="Published, but the Drive tidy-up did not finish"
          detail={failedMoves.map((h) => `${h.filename}: ${h.error}`).join('\n')}
        >
          The product is live and the photographs are recorded as published. Only the move
          into /Processed failed, which is housekeeping — nothing needs undoing and it can be
          retried later.
        </Notice>
      ) : null}
    </div>
  )
}

/**
 * The same rules as the server, for a product that does not exist yet.
 *
 * Not a second ruleset: `src/lib/publish/validate.ts` decides at publish, and it
 * is what runs the moment a draft exists. This only covers the window before
 * there is anything to ask the server about.
 */
function localBlocks(
  form: EditorForm,
  category: { name: string; skuPrefix: string; shopifyTag: string | null; defaultWeightG: number | null } | null,
): readonly PublishBlock[] {
  const blocks: PublishBlock[] = []
  const price = parseRupeesToPaise(form.price)
  if (!price.ok) {
    blocks.push({ code: 'price_missing', field: 'price', message: price.reason })
  }
  const stock =
    form.variantKind === 'none'
      ? Number.parseInt(form.stock.trim() || '0', 10)
      : form.variants.reduce((total, variant) => {
          const value = Number.parseInt(variant.stock.trim() || '0', 10)
          return total + (Number.isFinite(value) && value > 0 ? value : 0)
        }, 0)
  if ((!Number.isFinite(stock) || stock <= 0) && !form.allowZeroStock) {
    blocks.push({
      code: 'stock_zero',
      field: 'stock',
      message:
        `${form.variantKind === 'none' ? 'Stock' : 'Total choice stock'} is zero. ` +
        'Tick "publish with zero stock" if that is deliberate — a live product nobody can buy is usually a mistake, not a decision.',
    })
  }
  if (form.variantKind !== 'none' && form.variants.length === 0) {
    blocks.push({
      code: 'variants_missing',
      field: 'variants',
      message:
        form.variantKind === 'colour'
          ? 'Stock is set to “By colour”, but no colours have been added.'
          : form.variantKind === 'size'
            ? 'Stock is set to “By size”, but no ring sizes have been added.'
            : 'Stock is set to “Numbered choices”, but no numbered pieces have been added.',
    })
  }
  if (!form.materialId && !form.customMaterial.trim()) {
    blocks.push({
      code: 'material_missing',
      field: 'material',
      message:
        'No material. It supplies the first description line and the Shopify material field. Pick 304, 316L or Brass, or enter a custom material.',
    })
  }
  if (form.weight.trim() === '' && (category?.defaultWeightG ?? null) === null) {
    blocks.push({
      code: 'weight_unknown',
      field: 'weight',
      message: `Weight is unknown — neither this product nor the ${category?.name ?? 'category'} has one, and NULL means nobody has said rather than zero.`,
    })
  }
  if (category && category.shopifyTag === null) {
    blocks.push({
      code: 'tag_unconfirmed',
      field: 'category',
      message: `The ${category.name} category (${category.skuPrefix}) has no confirmed Shopify tag. Collections are tag-driven, so guessing one publishes the product straight out of its collection without any error.`,
    })
  }
  if (form.images.length === 0) {
    blocks.push({
      code: 'images_missing',
      field: 'images',
      message:
        'No image selected. Pick at least one version to publish — a listing with no photograph is the one thing a wholesale buyer cannot work around.',
    })
  }
  return blocks
}
