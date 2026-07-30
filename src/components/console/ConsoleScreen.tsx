'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  colourSuggestionsAction,
  detachPhotoAction,
  groupPhotosAction,
  openDraftAction,
  previewPhotosAction,
  publishDraftAction,
  refreshQueueAction,
  saveDraftAction,
  type ActionError,
  type ActionResult,
  type DraftBundle,
  type PublishSummary,
} from '@/app/console/actions'
import type { Operator } from '@/lib/auth/authorize'
import { parseRupeesToPaise } from '@/lib/console/money'
import { predictIdentity, type PredictedIdentity } from '@/lib/console/preview'
import {
  QUEUE_VIEW_LABELS,
  tilesForQueueView,
  type QueueView,
} from '@/lib/console/queue-view'
import type {
  ColourSuggestion,
  ConsoleCatalog,
  PhotoSummary,
  QueueSnapshot,
} from '@/lib/console/types'
import type { PublishBlock } from '@/lib/publish/validate'

import { DraftEditor, type EditorForm } from './DraftEditor'
import { Card, Notice, StatPill } from './primitives'
import { QueueGrid } from './QueueGrid'
import { Sidebar } from './Sidebar'

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
 * material and stock carry to the NEXT new product because a batch is a hundred
 * necklaces in a row. Price, colours, suffix and images never carry — repeating
 * the previous product's price is how the wrong price goes out. And a saved
 * draft's own values always win: a sticky default is a starting point for
 * something new, never an overwrite of something stored.
 */

const STICKY_KEY = 'loupe.sticky.v1'
/** Presigned URLs live 15 minutes; refresh well inside that. */
const QUEUE_REFRESH_MS = 9 * 60 * 1000

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
  weight: '',
  titleSuffix: '',
  colours: [],
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

function formFromBundle(bundle: DraftBundle): EditorForm {
  const draft = bundle.draft
  return {
    categoryId: draft.categoryId,
    materialId: draft.materialId,
    customMaterial: draft.customMaterial ?? '',
    descriptionOverride: draft.descriptionOverride,
    price: draft.pricePaise === null ? '' : formatRupees(draft.pricePaise),
    stock: String(draft.stock),
    // NULL is "nobody has said" and is NOT the same as 0 (D19), so an unset
    // weight stays an empty field rather than becoming a typed zero.
    weight: draft.weightG === null ? '' : String(draft.weightG),
    titleSuffix: draft.titleSuffix ?? '',
    colours: [...draft.colours],
    images: [...draft.images]
      .sort((a, b) => a.position - b.position)
      .map((image) => ({ intakeFileId: image.intakeFileId, imageVersionId: image.imageVersionId })),
    allowZeroStock: false,
  }
}

function formatRupees(paise: number): string {
  const rupees = Math.trunc(paise / 100)
  const fraction = paise % 100
  return fraction === 0 ? String(rupees) : `${rupees}.${String(fraction).padStart(2, '0')}`
}

export interface ConsoleScreenProps {
  readonly operator: Operator
  readonly initialQueue: QueueSnapshot
  readonly catalog: ConsoleCatalog
  readonly initialBundle: DraftBundle | null
}

export function ConsoleScreen({
  operator,
  initialQueue,
  catalog,
  initialBundle,
}: ConsoleScreenProps) {
  const [queue, setQueue] = useState(initialQueue)
  const [bundle, setBundle] = useState<DraftBundle | null>(initialBundle)
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

  const priceRef = useRef<HTMLInputElement>(null)
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
  const previewPhotos = preview.key === selectionKey ? preview.photos : []
  const photos = mode === 'draft' ? (bundle?.draft.photos ?? []) : previewPhotos
  const visibleTiles = useMemo(() => tilesForQueueView(queue, queueView), [queue, queueView])
  const listedReadOnly = bundle?.draft.status === 'published'

  /** Signed URLs expire. Re-signing on a timer is cheaper than a broken grid. */
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const result = await refreshQueueAction()
      if (result.ok) setQueue(result.data)
    }, QUEUE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

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

  const category = catalog.categories.find((c) => c.id === form.categoryId) ?? null

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
    const stickyCategory = catalog.categories.find((c) => c.id === sticky.categoryId) ?? null
    return {
      ...EMPTY_FORM,
      categoryId: stickyCategory?.id ?? null,
      materialId: sticky.materialId ?? null,
      customMaterial: sticky.customMaterial,
      stock: sticky.stock || String(stickyCategory?.defaultStock ?? 0),
    }
  }, [catalog.categories])

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
    const data = handleResult(await groupPhotosAction(form.categoryId, selectedPhotoIds))
    if (!data) return null
    setQueue(data.queue)
    setBundle(data.bundle)
    setColours(data.bundle.colours)
    return data.bundle
  }, [bundle, form.categoryId, selectedPhotoIds, handleResult])

  const saveRequest = useCallback(
    (target: DraftBundle) => {
      const price = parseRupeesToPaise(form.price)
      const stock = Number.parseInt(form.stock.trim() || '0', 10)
      const weight = form.weight.trim()
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
        colours: form.colours,
        images: form.images.map((image, index) => ({
          imageVersionId: image.imageVersionId,
          position: index,
        })),
        allowZeroStock: form.allowZeroStock,
      }
    },
    [form],
  )

  const rememberSticky = useCallback(() => {
    writeSticky({
      categoryId: form.categoryId,
      materialId: form.materialId,
      customMaterial: form.customMaterial.trim(),
      stock: form.stock,
    })
  }, [form.categoryId, form.customMaterial, form.materialId, form.stock])

  const handleSaveDraft = useCallback(async () => {
    setBusy('save')
    setLastPublish(null)
    const target = await ensureDraft()
    if (!target) {
      setBusy(null)
      return
    }
    const data = handleResult(await saveDraftAction(saveRequest(target)))
    if (data) {
      setQueue(data.queue)
      applyBundle(data.bundle)
      rememberSticky()
    }
    setBusy(null)
  }, [applyBundle, ensureDraft, handleResult, rememberSticky, saveRequest])

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

  const handlePublish = useCallback(async () => {
    setBusy('publish')
    setLastPublish(null)
    const target = await ensureDraft()
    if (!target) {
      setBusy(null)
      return
    }
    const data = handleResult(await publishDraftAction(saveRequest(target)))
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
      const refreshed = await openDraftAction(target.draft.id)
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

  const chooseVersion = useCallback((intakeFileId: string, imageVersionId: string) => {
    setForm((current) => ({
      ...current,
      images: current.images.map((image) =>
        image.intakeFileId === intakeFileId ? { ...image, imageVersionId } : image,
      ),
    }))
  }, [])

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
    <div className="grid h-dvh grid-cols-[216px_1fr] gap-[18px] p-[18px]">
      <Sidebar operator={operator} attentionCount={queue.attentionCount} />

      <main className="flex min-h-0 min-w-0 flex-col gap-3.5">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-[26px] font-medium tracking-[-0.025em]">Console</h1>
            <div className="text-[12px] text-muted-foreground">{today}</div>
          </div>
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <StatPill
              value={queue.tiles.length}
              label="pending"
              selected={queueView === 'pending'}
              onClick={() => showQueueView('pending')}
            />
            <StatPill
              value={queue.ungroupedCount}
              label="ungrouped"
              selected={queueView === 'ungrouped'}
              onClick={() => showQueueView('ungrouped')}
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

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_372px] gap-3.5 overflow-hidden">
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
              <button
                type="button"
                onClick={async () => {
                  const result = await refreshQueueAction()
                  if (result.ok) setQueue(result.data)
                }}
                className="ml-auto rounded-pill bg-chip px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-[#ebebeb]"
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
              categories={catalog.categories}
              materials={catalog.materials}
              colourSuggestions={colours}
              identity={identity}
              identityLocked={Boolean(bundle?.draft.reservedSku)}
              readOnly={listedReadOnly}
              blocks={blocks}
              busy={busy}
              dirty={dirty}
              priceRef={priceRef}
              onPublish={() => void handlePublish()}
              onSaveDraft={() => void handleSaveDraft()}
              onDetach={bundle && !listedReadOnly ? (id) => void handleDetach(id) : null}
              onMoveImage={moveImage}
              onChooseVersion={chooseVersion}
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
    </div>
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
  const stock = Number.parseInt(form.stock.trim() || '0', 10)
  if ((!Number.isFinite(stock) || stock <= 0) && !form.allowZeroStock) {
    blocks.push({
      code: 'stock_zero',
      field: 'stock',
      message:
        'Stock is zero. Tick "publish with zero stock" if that is deliberate — a live product nobody can buy is usually a mistake, not a decision.',
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
