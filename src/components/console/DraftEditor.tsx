'use client'

import { useState, type RefObject } from 'react'

import {
  colourPaletteNames,
  colourSwatchBackground,
} from '@/lib/console/colour-swatch'
import { formatPaise } from '@/lib/console/money'
import type { PredictedIdentity } from '@/lib/console/preview'
import type {
  CategoryOption,
  ColourSuggestion,
  MaterialOption,
  PhotoSummary,
  VariantKind,
} from '@/lib/console/types'
import {
  defaultDescriptionText,
  DESCRIPTION_OVERRIDE_MAX_LENGTH,
} from '@/lib/publish/description'
import type { PublishBlock } from '@/lib/publish/validate'
import { cn } from '@/lib/utils'

import { ImageLightbox, type LightboxImage } from './ImageLightbox'
import { Chip, FeatureCard, SectionLabel } from './primitives'

/** Quick ring-size choices; custom labels remain available beside them. */
const RING_SIZE_SUGGESTIONS = Array.from({ length: 27 }, (_, index) => String(index + 4))

/**
 * The product editor.
 *
 * It is a `<form>`, and that is a keyboard decision rather than a markup one.
 * Enter inside a single-line input submits a form natively, which is exactly the
 * "type the price, press Enter" path — and Enter on a `type="button"` chip
 * activates the chip instead, which is exactly the "must not publish while a
 * choice interaction is open" requirement. Both come free; a global key handler
 * would have had to reimplement them and would fire while the operator typed
 * into something unrelated.
 *
 * The colour and size entry fields need help because they are inputs inside the
 * same form: Enter there adds the choice and stops the publish submit.
 */

export interface EditorImage {
  readonly intakeFileId: string
  readonly imageVersionId: string
  /** Null means a general gallery image; otherwise this is the matching colour variant. */
  readonly colourValue: string | null
}

export interface EditorForm {
  readonly categoryId: string | null
  readonly materialId: string | null
  readonly customMaterial: string
  /** Null uses the standard six bullets; a string is the operator's replacement. */
  readonly descriptionOverride: string | null
  /** Raw text. Parsed to paise by a string parser, never by a float. */
  readonly price: string
  /** Used only when variantKind is none. Option products derive total stock. */
  readonly stock: string
  /** Empty means "use the category default" — NOT "zero" (D19). */
  readonly weight: string
  readonly titleSuffix: string
  readonly variantKind: VariantKind
  readonly variants: readonly EditorVariant[]
  readonly images: readonly EditorImage[]
  readonly allowZeroStock: boolean
}

export interface EditorVariant {
  readonly value: string
  /** Raw numeric input text; parsed without treating an empty field as valid stock. */
  readonly stock: string
}

export interface DraftEditorProps {
  readonly mode: 'empty' | 'new' | 'draft'
  readonly photos: readonly PhotoSummary[]
  readonly form: EditorForm
  readonly onChange: (patch: Partial<EditorForm>) => void
  readonly categories: readonly CategoryOption[]
  readonly materials: readonly MaterialOption[]
  readonly colourSuggestions: readonly ColourSuggestion[]
  readonly identity: PredictedIdentity | null
  readonly identityLocked: boolean
  readonly readOnly?: boolean
  readonly blocks: readonly PublishBlock[]
  readonly busy: string | null
  /** True while THIS draft's local save + background Shopify push is starting. */
  readonly savingDraft: boolean
  /** Photograph ids with a delete in flight — deletes run in parallel now. */
  readonly deletingIds: ReadonlySet<string>
  /** Signed 1280px previews backfilled for Drive originals, by image version id. */
  readonly originalPreviews: Readonly<Record<string, string>>
  readonly dirty: boolean
  readonly priceRef: RefObject<HTMLInputElement | null>
  readonly onPublish: () => void
  readonly onSaveDraft: () => void
  readonly onDetach: ((intakeFileId: string) => void) | null
  readonly onMoveImage: (imageVersionId: string, delta: number) => void
  readonly onChooseVersion: (intakeFileId: string, imageVersionId: string) => void
  readonly onRedo: (intakeFileId: string, filename: string) => void
  /** Opens the complete category + SKU-sequence creation flow. */
  readonly onAddCategory: () => void
  /** Present only while the photograph is ungrouped and deletable from Loupe. */
  readonly onDeletePhoto: ((intakeFileId: string, filename: string) => void) | null
  readonly children?: React.ReactNode
}

export function DraftEditor(props: DraftEditorProps) {
  const {
    mode,
    photos,
    form,
    onChange,
    categories,
    materials,
    colourSuggestions,
    identity,
    identityLocked,
    readOnly = false,
    blocks,
    busy,
    savingDraft,
    deletingIds,
    originalPreviews,
    dirty,
    priceRef,
    onPublish,
    onSaveDraft,
    onDetach,
    onMoveImage,
    onChooseVersion,
    onRedo,
    onAddCategory,
    onDeletePhoto,
    children,
  } = props

  const [colourDraft, setColourDraft] = useState('')
  const [sizeDraft, setSizeDraft] = useState('')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  /**
   * Progressive disclosure for the three choice fields. `null` means "follow
   * the flow": an unfilled category opens itself, then material, and a filled
   * field collapses to its one-line summary. Price and stock never collapse —
   * they are the operator's two-keystroke path.
   */
  const [openSection, setOpenSection] = useState<'category' | 'material' | 'description' | null>(
    null,
  )
  const [categoryQuery, setCategoryQuery] = useState('')
  const openLightbox = (index: number) => setLightboxIndex(index)
  const category = categories.find((c) => c.id === form.categoryId) ?? null
  const selectedMaterial = materials.find((m) => m.id === form.materialId)?.name ?? null
  const materialName = form.customMaterial.trim() || selectedMaterial
  const defaultDescription = materialName ? defaultDescriptionText(materialName) : ''
  const totalVariantStock = form.variants.reduce((sum, variant) => {
    const stock = Number.parseInt(variant.stock.trim() || '0', 10)
    return sum + (Number.isFinite(stock) && stock > 0 ? stock : 0)
  }, 0)
  const newOptionStock = (form.variants[0]?.stock ?? form.stock) || '0'
  const availableColourNames = colourPaletteNames(colourSuggestions)

  const setVariantKind = (kind: VariantKind) => {
    if (kind === form.variantKind) return
    if (kind === 'none') {
      onChange({
        variantKind: kind,
        variants: [],
        stock: form.variantKind === 'none' ? form.stock : String(totalVariantStock),
        images: form.images.map((image) => ({ ...image, colourValue: null })),
      })
      return
    }
    if (kind === 'number') {
      onChange({
        variantKind: kind,
        variants: Array.from({ length: 30 }, (_, index) => ({
          value: String(index + 1),
          stock: '0',
        })),
        images: form.images.map((image) => ({ ...image, colourValue: null })),
      })
      return
    }
    onChange({
      variantKind: kind,
      variants: [],
      ...(kind === 'colour'
        ? {}
        : { images: form.images.map((image) => ({ ...image, colourValue: null })) }),
    })
  }

  const assignImageColour = (intakeFileId: string, colourValue: string | null) => {
    const key = colourValue?.toLowerCase() ?? null
    onChange({
      images: form.images.map((image) => {
        if (image.intakeFileId === intakeFileId) return { ...image, colourValue }
        // Shopify gives each variant one featured image. Reassigning a colour
        // therefore releases it from the previous photograph instead of
        // creating an ambiguous two-images-for-one-variant state.
        if (key && image.colourValue?.toLowerCase() === key) {
          return { ...image, colourValue: null }
        }
        return image
      }),
    })
  }

  const setNumberedChoiceCount = (count: number) => {
    const bounded = Math.max(0, Math.min(100, count))
    const stockByValue = new Map(form.variants.map((variant) => [variant.value, variant.stock]))
    onChange({
      variants: Array.from({ length: bounded }, (_, index) => {
        const value = String(index + 1)
        return { value, stock: stockByValue.get(value) ?? '0' }
      }),
    })
  }

  const addSize = (rawValue: string) => {
    const value = rawValue.trim().replace(/\s+/g, ' ')
    if (
      !value ||
      form.variants.some(
        (variant) => variant.value.toLowerCase() === value.toLowerCase(),
      )
    ) {
      return
    }
    onChange({ variants: [...form.variants, { value, stock: newOptionStock }] })
  }

  const setVariantStock = (value: string, stock: string) =>
    onChange({
      variants: form.variants.map((variant) =>
        variant.value === value ? { ...variant, stock } : variant,
      ),
    })

  if (mode === 'empty') {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-[13px] text-ink-soft">Select a photograph to start a product.</p>
        <p className="mt-2 max-w-[260px] text-[11.5px] leading-relaxed text-muted-foreground">
          Pick more than one if they are the same piece. Arrow keys move around the grid;
          Space selects.
        </p>
        {children ? <div className="mt-4 w-full text-left">{children}</div> : null}
      </div>
    )
  }

  const materialFilled = Boolean(form.materialId || form.customMaterial.trim())
  const effectiveOpen =
    openSection ?? (!form.categoryId ? 'category' : !materialFilled ? 'material' : null)
  const toggleSection = (section: 'category' | 'material' | 'description') =>
    setOpenSection((current) => (current === section ? null : section))
  const filteredCategories = categoryQuery.trim()
    ? categories.filter((option) => {
        const query = categoryQuery.trim().toLowerCase()
        return (
          option.name.toLowerCase().includes(query) ||
          option.skuPrefix.toLowerCase().includes(query)
        )
      })
    : categories

  const photoByIntake = new Map(photos.map((p) => [p.intakeFileId, p]))
  const orderedImages = form.images
    .map((image) => ({ image, photo: photoByIntake.get(image.intakeFileId) }))
    .filter((row): row is { image: EditorImage; photo: PhotoSummary } => row.photo !== undefined)

  const blockFor = (field: string) => blocks.find((b) => b.field === field)

  /**
   * Full-size review, in the operator's chosen publish order — so stepping
   * through the lightbox is stepping through what Shopify will actually show.
   * Only the SELECTED version of each photograph appears here; comparing
   * versions is what the orig/v1/v2 chips below are for.
   */
  const lightboxImages: LightboxImage[] = orderedImages
    .map((row) => {
      const version = row.photo.versions.find((v) => v.id === row.image.imageVersionId)
      if (!version?.full) return null
      return {
        url: version.full.url,
        alt: row.photo.description ?? row.photo.filename,
        caption: `${row.photo.filename} · ${
          version.kind === 'original' ? 'original' : `v${version.versionNo}`
        }`,
      }
    })
    .filter((image): image is LightboxImage => image !== null)

  return (
    <form
      className="flex h-full min-h-0 flex-col overflow-hidden"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && !readOnly) onPublish()
      }}
    >
      <ImageLightbox
        images={lightboxImages}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onIndexChange={setLightboxIndex}
      />

      <div className="loupe-scroll min-h-0 flex-1 overflow-y-auto pr-1">
        {/* Full review in publish order. The editor scrolls vertically, so a
            multi-photo product shows every selected photograph at review size. */}
        <div className="flex flex-col gap-3">
          {orderedImages.length > 0 ? (
            orderedImages.map((row, index) => {
              const version = row.photo.versions.find(
                (candidate) => candidate.id === row.image.imageVersionId,
              )
              const fullSizeIndex = version?.full
                ? lightboxImages.findIndex((image) => image.url === version.full!.url)
                : -1
              // A Drive original is the raw multi-MB download; render its
              // backfilled 1280px preview (or thumb) in the panel and keep the
              // exact bytes for the lightbox. Generated versions are already
              // display-sized.
              const panelUrl =
                version?.kind === 'original'
                  ? (version.thumb?.url ??
                    (version.id ? originalPreviews[version.id] : undefined) ??
                    version.full?.url)
                  : version?.full?.url
              return (
                <div
                  key={`preview:${row.image.intakeFileId}`}
                  className="relative aspect-[4/3] shrink-0 overflow-hidden rounded-panel bg-chip"
                >
                  {version?.full ? (
                    <button
                      // This sits inside the editor's <form>, whose submit publishes the
                      // product — an implicit type="submit" here would publish on click.
                      type="button"
                      onClick={() => fullSizeIndex >= 0 && openLightbox(fullSizeIndex)}
                      aria-label={`View ${row.photo.filename} full size`}
                      title="View full size"
                      className="group absolute inset-0 cursor-zoom-in focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--ink)_inset]"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived, private-bucket URL. */}
                      <img
                        src={panelUrl ?? version.full.url}
                        alt={row.photo.description ?? row.photo.filename}
                        loading={index === 0 ? 'eager' : 'lazy'}
                        decoding="async"
                        className="absolute inset-0 size-full object-contain"
                      />
                      <span className="pointer-events-none absolute bottom-2 right-2 rounded-pill bg-ink/75 px-2.5 py-1 text-[10.5px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        Full size
                      </span>
                    </button>
                  ) : (
                    <span className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
                      no image selected
                    </span>
                  )}
                  <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-pill bg-white/90 px-2 py-1 text-[10px] font-medium text-ink shadow-sm backdrop-blur-sm">
                    {index + 1} of {orderedImages.length}
                  </span>
                  {index === 0 && form.variantKind === 'colour' && form.variants.length > 0 ? (
                    <div
                      className="pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap gap-1.5 rounded-pill bg-white/90 p-1.5 shadow-sm backdrop-blur-sm"
                      role="img"
                      aria-label={`Selected colours: ${form.variants.map((variant) => variant.value).join(', ')}`}
                    >
                      {form.variants.map((variant) => (
                        <ColourSwatch key={variant.value} name={variant.value} className="size-6" />
                      ))}
                    </div>
                  ) : null}
                  {index === 0 && form.variantKind === 'size' && form.variants.length > 0 ? (
                    <div
                      className="pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap gap-1.5 rounded-pill bg-white/90 p-1.5 shadow-sm backdrop-blur-sm"
                      role="img"
                      aria-label={`Selected sizes: ${form.variants.map((variant) => variant.value).join(', ')}`}
                    >
                      {form.variants.map((variant) => (
                        <span
                          key={variant.value}
                          className="grid min-w-6 place-items-center rounded-pill bg-ink px-2 py-1 text-[10px] font-medium text-white"
                        >
                          {variant.value}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })
          ) : (
            <div className="relative aspect-[4/3] rounded-panel bg-chip">
              <span className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
                no image selected
              </span>
            </div>
          )}
        </div>
        {orderedImages.length > 1 ? (
          <p className="mt-2 text-[10.5px] text-muted-foreground">
            Scroll down to review all {orderedImages.length} photographs in Shopify order.
          </p>
        ) : null}

        {/* Images: version choice per photograph, plus order. */}
        <div className="mt-4">
          <SectionLabel>
            Images · {orderedImages.length} {orderedImages.length === 1 ? 'photo' : 'photos'}
          </SectionLabel>
          <ul className="mt-2 flex flex-col gap-2">
            {orderedImages.map((row, index) => (
              <li
                key={row.image.intakeFileId}
                className="flex items-center gap-2.5 rounded-panel bg-chip p-2"
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[9px] font-semibold text-white">
                  {index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <button
                    // Inside the publish <form>: never an implicit submit.
                    type="button"
                    onClick={() => openLightbox(index)}
                    title="View full size"
                    className="block max-w-full cursor-zoom-in truncate font-mono text-[11px] text-ink-soft underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current focus:outline-none focus-visible:decoration-current"
                  >
                    {row.photo.filename}
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {row.photo.versions.map((version) => (
                      <Chip
                        key={version.id}
                        selected={version.id === row.image.imageVersionId}
                        disabled={readOnly}
                        title={
                          version.kind === 'original'
                            ? 'The photographer’s untouched file'
                            : `Generated${version.model ? ` · ${version.model}` : ''}`
                        }
                        onClick={() => onChooseVersion(row.image.intakeFileId, version.id)}
                      >
                        {version.kind === 'original' ? 'orig' : `v${version.versionNo}`}
                      </Chip>
                    ))}
                    {row.photo.descriptionMissing ? (
                      <span
                        className="rounded-pill px-2 py-[7px] text-[10.5px] text-amber"
                        title="The describer failed for this photograph, so its alt text falls back to the product title."
                      >
                        no description
                      </span>
                    ) : null}
                    {row.photo.source === 'manual' ? (
                      <span
                        className="rounded-pill bg-surface px-2 py-[7px] text-[10.5px] text-ink-soft"
                        title="Uploaded as catalogue-ready. The original is selected and no AI enhancement was run."
                      >
                        ready upload · AI bypassed
                      </span>
                    ) : null}
                    {row.photo.possibleDuplicate ? (
                      <span
                        className="rounded-pill bg-[#faf2e4] px-2 py-[7px] text-[10.5px] text-amber"
                        title={`Perceptual-hash distance ${row.photo.possibleDuplicate.distance}. This warning does not block publishing.`}
                      >
                        possible duplicate · {row.photo.possibleDuplicate.matchFilename}
                      </span>
                    ) : null}
                    {row.photo.redo?.status === 'queued' ||
                    row.photo.redo?.status === 'processing' ? (
                      <span
                        className="rounded-pill bg-surface px-2 py-[7px] text-[10.5px] text-ink-soft"
                        role="status"
                      >
                        {row.photo.redo.status === 'queued' ? 'redo queued' : 'redoing…'}
                      </span>
                    ) : row.photo.redo?.status === 'failed' ? (
                      <span
                        className="rounded-pill px-2 py-[7px] text-[10.5px] text-amber"
                        title={row.photo.redo.error ?? 'The last redo failed.'}
                      >
                        redo failed
                      </span>
                    ) : null}
                    <button
                      type="button"
                      disabled={readOnly || busy !== null}
                      onClick={() => onRedo(row.image.intakeFileId, row.photo.filename)}
                      title={
                        row.photo.source === 'manual'
                          ? 'Run this ready upload through the image-enhancement model'
                          : 'Create another AI-enhanced version from the untouched original'
                      }
                      className="rounded-pill bg-surface px-2.5 py-[7px] text-[10.5px] font-medium text-ink-soft transition-colors hover:bg-white disabled:opacity-40"
                    >
                      {busy === `redo:${row.image.intakeFileId}`
                        ? 'Running AI…'
                        : row.photo.source === 'manual'
                          ? 'Run AI enhancement'
                          : 'Redo image'}
                    </button>
                  </div>
                  {form.variantKind === 'colour' && form.variants.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label={`Colour shown in ${row.photo.filename}`}>
                      <span className="mr-1 text-[10.5px] text-muted-foreground">Image for</span>
                      <button
                        type="button"
                        disabled={readOnly}
                        aria-pressed={row.image.colourValue === null}
                        onClick={() => assignImageColour(row.image.intakeFileId, null)}
                        className={cn(
                          'rounded-pill px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40',
                          row.image.colourValue === null
                            ? 'bg-ink text-white'
                            : 'bg-surface text-ink-soft hover:bg-white',
                        )}
                      >
                        All colours
                      </button>
                      {form.variants.map((variant) => {
                        const selected =
                          row.image.colourValue?.toLowerCase() === variant.value.toLowerCase()
                        return (
                          <button
                            key={variant.value}
                            type="button"
                            disabled={readOnly}
                            aria-label={`Use ${row.photo.filename} for ${variant.value}`}
                            aria-pressed={selected}
                            title={variant.value}
                            onClick={() =>
                              assignImageColour(row.image.intakeFileId, variant.value)
                            }
                            className={cn(
                              'rounded-full p-0.5 outline-none transition-transform hover:scale-110 disabled:opacity-40',
                              selected
                                ? 'shadow-[0_0_0_2px_var(--ink)]'
                                : 'shadow-[0_0_0_1px_#d5d5d5]',
                            )}
                          >
                            <ColourSwatch name={variant.value} className="size-5" />
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={`Move ${row.photo.filename} earlier`}
                    disabled={readOnly || index === 0}
                    onClick={() => onMoveImage(row.image.imageVersionId, -1)}
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    label={`Move ${row.photo.filename} later`}
                    disabled={readOnly || index === orderedImages.length - 1}
                    onClick={() => onMoveImage(row.image.imageVersionId, 1)}
                  >
                    ↓
                  </IconButton>
                  {onDetach ? (
                    <IconButton
                      label={`Return ${row.photo.filename} to the queue`}
                      onClick={() => onDetach(row.image.intakeFileId)}
                    >
                      ×
                    </IconButton>
                  ) : null}
                  {onDeletePhoto ? (
                    <button
                      type="button"
                      disabled={deletingIds.has(row.image.intakeFileId)}
                      onClick={() => onDeletePhoto(row.image.intakeFileId, row.photo.filename)}
                      className="rounded-pill px-2 py-1 text-[10px] font-medium text-amber transition-colors hover:bg-white disabled:opacity-40"
                    >
                      {deletingIds.has(row.image.intakeFileId) ? 'Deleting…' : 'Delete'}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {blockFor('images') ? (
            <p className="mt-2 text-[11.5px] text-amber">{blockFor('images')!.message}</p>
          ) : null}
        </div>

        {/* Category — the first of the two human judgements. Collapses to its
            choice once made; searchable while open so a growing catalogue is
            never an endless chip wall. */}
        <Disclosure
          label="Category"
          value={category ? `${category.name} · ${category.skuPrefix}` : null}
          placeholder="Choose category"
          open={effectiveOpen === 'category'}
          attention={Boolean(blockFor('category'))}
          locked={identityLocked}
          onToggle={() => toggleSection('category')}
        >
          {categories.length > 8 ? (
            <input
              value={categoryQuery}
              onChange={(event) => setCategoryQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault()
              }}
              aria-label="Search categories"
              placeholder="Search categories…"
              className="mb-2 w-full rounded-field bg-surface px-3.5 py-2 text-[12.5px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:text-[#bfbfc4]"
            />
          ) : null}
          <div className="loupe-scroll flex max-h-56 flex-wrap content-start gap-1.5 overflow-y-auto">
            {filteredCategories.map((option) => (
              <Chip
                key={option.id}
                selected={option.id === form.categoryId}
                disabled={readOnly || (identityLocked && option.id !== form.categoryId)}
                title={
                  identityLocked && option.id !== form.categoryId
                    ? 'This product already holds a reserved SKU from its category’s sequence, so the category is frozen. Create a new draft to change it.'
                    : option.shopifyTag === null
                      ? `${option.name} has no confirmed Shopify tag yet — publishing is blocked until somebody reads it off a live product.`
                      : `${option.skuPrefix} · next ${option.skuPrefix}${String(option.lastNumber + 1).padStart(3, '0')}`
                }
                onClick={() => {
                  onChange({ categoryId: option.id })
                  setCategoryQuery('')
                  setOpenSection(null)
                }}
              >
                {option.name}
                {option.shopifyTag === null ? ' ·' : ''}
              </Chip>
            ))}
            {filteredCategories.length === 0 ? (
              <p className="px-1 py-2 text-[11.5px] text-muted-foreground">
                No category matches “{categoryQuery.trim()}”.
              </p>
            ) : null}
            {!readOnly && !identityLocked ? (
              <Chip ghost title="Create a category and its own SKU sequence" onClick={onAddCategory}>
                + New category
              </Chip>
            ) : null}
          </div>
          {identityLocked ? (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Category is locked: this draft holds{' '}
              <span className="font-mono">{identity?.sku}</span> from that sequence, and the
              handle behind it is what stops a retry creating a second product. To change the
              category, start a new draft — the abandoned number is a harmless gap.
            </p>
          ) : null}
          {blockFor('category') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('category')!.message}
            </p>
          ) : null}
        </Disclosure>

        <Disclosure
          label="Material"
          value={materialName}
          placeholder="Choose material"
          open={effectiveOpen === 'material'}
          attention={Boolean(blockFor('material'))}
          onToggle={() => toggleSection('material')}
        >
          <div className="flex flex-wrap gap-1.5">
            {materials.map((option) => (
              <Chip
                key={option.id}
                selected={option.id === form.materialId}
                disabled={readOnly}
                onClick={() => {
                  onChange({ materialId: option.id, customMaterial: '' })
                  setOpenSection(null)
                }}
              >
                {option.name}
              </Chip>
            ))}
          </div>
          <input
            value={form.customMaterial}
            disabled={readOnly}
            maxLength={100}
            onFocus={() => setOpenSection('material')}
            onChange={(event) =>
              onChange({ customMaterial: event.target.value, materialId: null })
            }
            onKeyDown={(event) => {
              // A custom material is still a choice field. Enter here must not
              // publish the form while the operator is typing it.
              if (event.key === 'Enter') {
                event.preventDefault()
                if (form.customMaterial.trim()) setOpenSection(null)
              }
            }}
            aria-label="Custom material"
            placeholder="Or type a custom material"
            className="mt-2.5 w-full rounded-field bg-surface px-3.5 py-2.5 text-[13px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:text-[#bfbfc4]"
          />
          {blockFor('material') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('material')!.message}
            </p>
          ) : null}
        </Disclosure>

        <Disclosure
          label="Description"
          value={
            form.descriptionOverride !== null
              ? 'Custom text for this product'
              : materialName
                ? 'Standard six bullets'
                : null
          }
          placeholder="Follows the material"
          open={effectiveOpen === 'description'}
          onToggle={() => toggleSection('description')}
        >
          {form.descriptionOverride === null ? (
            <>
              <div className="whitespace-pre-line rounded-field bg-surface px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-soft">
                {defaultDescription ||
                  'Choose a material to preview the standard six-point description.'}
              </div>
              {!readOnly ? (
                <button
                  type="button"
                  disabled={!defaultDescription}
                  onClick={() => onChange({ descriptionOverride: defaultDescription })}
                  className="mt-2 rounded-pill bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-white disabled:opacity-45"
                >
                  Edit default description
                </button>
              ) : null}
            </>
          ) : (
            <>
              <textarea
                value={form.descriptionOverride}
                disabled={readOnly}
                maxLength={DESCRIPTION_OVERRIDE_MAX_LENGTH}
                rows={7}
                onChange={(event) => onChange({ descriptionOverride: event.target.value })}
                aria-label="Product description"
                className="w-full resize-y rounded-field bg-surface px-3.5 py-3 text-[12px] leading-relaxed text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
              />
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => onChange({ descriptionOverride: null })}
                  className="mt-2 rounded-pill bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-white"
                >
                  Use standard description
                </button>
              ) : null}
            </>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            The standard text follows the material. Editing creates a plain-text exception for
            this product only.
          </p>
        </Disclosure>

        <Field label="Stock method">
          <div className="flex flex-wrap gap-1.5">
            <Chip
              selected={form.variantKind === 'none'}
              disabled={readOnly}
              onClick={() => setVariantKind('none')}
            >
              One stock
            </Chip>
            <Chip
              selected={form.variantKind === 'colour'}
              disabled={readOnly}
              onClick={() => setVariantKind('colour')}
            >
              By colour
            </Chip>
            <Chip
              selected={form.variantKind === 'size'}
              disabled={readOnly}
              onClick={() => setVariantKind('size')}
            >
              By size
            </Chip>
            <Chip
              selected={form.variantKind === 'number'}
              disabled={readOnly}
              onClick={() => setVariantKind('number')}
            >
              Numbered choices
            </Chip>
          </div>

          {form.variantKind === 'colour' ? (
            <div className="mt-3">
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Colour palette"
              >
                {availableColourNames
                  .filter(
                    (name) =>
                      !form.variants.some(
                        (variant) => variant.value.toLowerCase() === name.toLowerCase(),
                      ),
                  )
                  .slice(0, 12)
                  .map((name) => {
                    const suggestion = colourSuggestions.find(
                      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
                    )
                    return (
                      <button
                        key={name}
                        type="button"
                        disabled={readOnly}
                        aria-label={`Add ${name}`}
                        title={
                          suggestion
                            ? `${name} · used ${suggestion.usageCount}× in ${category?.name ?? 'this category'}`
                            : `Add ${name}`
                        }
                        onClick={() =>
                          onChange({
                            variants: [...form.variants, { value: name, stock: newOptionStock }],
                          })
                        }
                        className="rounded-full outline-none transition-transform hover:scale-110 focus-visible:shadow-[0_0_0_2px_var(--ink)] disabled:opacity-40"
                      >
                        <ColourSwatch name={name} className="size-8" />
                      </button>
                    )
                  })}
                <input
                  value={colourDraft}
                  disabled={readOnly}
                  onChange={(event) => setColourDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const name = colourDraft.trim()
                      if (
                        name &&
                        !form.variants.some(
                          (variant) => variant.value.toLowerCase() === name.toLowerCase(),
                        )
                      ) {
                        onChange({
                          variants: [
                            ...form.variants,
                            { value: name, stock: newOptionStock },
                          ],
                        })
                      }
                      setColourDraft('')
                    } else if (event.key === 'Escape' && colourDraft) {
                      event.preventDefault()
                      setColourDraft('')
                    }
                  }}
                  placeholder="+ other"
                  aria-label="Add a colour"
                  className="w-[104px] rounded-pill border border-dashed border-[#d5d5d5] bg-transparent px-3 py-[7px] text-[11.5px] text-ink-soft outline-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="mt-2.5 grid grid-cols-2 gap-2">
                {form.variants.map((variant) => (
                  <div
                    key={variant.value}
                    className="flex items-center gap-2 rounded-field bg-chip px-3 py-2"
                  >
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        onChange({
                          variants: form.variants.filter(
                            (candidate) => candidate.value !== variant.value,
                          ),
                          images: form.images.map((image) =>
                            image.colourValue?.toLowerCase() === variant.value.toLowerCase()
                              ? { ...image, colourValue: null }
                              : image,
                          ),
                        })
                      }
                      title={`Remove ${variant.value}`}
                      aria-label={`Remove ${variant.value}`}
                      className="shrink-0 rounded-full outline-none focus-visible:shadow-[0_0_0_2px_var(--ink)] disabled:cursor-default"
                    >
                      <ColourSwatch name={variant.value} className="size-7" />
                    </button>
                    <span className="sr-only">{variant.value}</span>
                    <input
                      value={variant.stock}
                      disabled={readOnly}
                      onChange={(event) => setVariantStock(variant.value, event.target.value)}
                      inputMode="numeric"
                      aria-label={`${variant.value} stock`}
                      className="w-14 rounded bg-surface px-2 py-1 text-right text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Pick from the visual palette, then set stock beside each swatch. Under Images,
                optionally point one photograph to each colour; Shopify will use it as that
                variant’s featured image.
              </p>
            </div>
          ) : null}

          {form.variantKind === 'size' ? (
            <div className="mt-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ring sizes">
                {RING_SIZE_SUGGESTIONS.filter(
                  (size) => !form.variants.some((variant) => variant.value === size),
                ).map((size) => (
                  <button
                    key={size}
                    type="button"
                    disabled={readOnly}
                    aria-label={`Add ring size ${size}`}
                    title={`Add size ${size}`}
                    onClick={() => addSize(size)}
                    className="grid min-w-8 place-items-center rounded-pill bg-chip px-2.5 py-2 text-[11px] font-medium text-ink-soft outline-none transition-colors hover:bg-[#ebebeb] focus-visible:shadow-[0_0_0_2px_var(--ink)] disabled:opacity-40"
                  >
                    {size}
                  </button>
                ))}
                <input
                  value={sizeDraft}
                  disabled={readOnly}
                  maxLength={100}
                  onChange={(event) => setSizeDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addSize(sizeDraft)
                      setSizeDraft('')
                    } else if (event.key === 'Escape' && sizeDraft) {
                      event.preventDefault()
                      setSizeDraft('')
                    }
                  }}
                  placeholder="+ custom"
                  aria-label="Add a custom ring size"
                  className="w-[104px] rounded-pill border border-dashed border-[#d5d5d5] bg-transparent px-3 py-[7px] text-[11.5px] text-ink-soft outline-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="mt-2.5 grid grid-cols-3 gap-2">
                {form.variants.map((variant) => (
                  <div
                    key={variant.value}
                    className="flex items-center gap-2 rounded-field bg-chip px-2.5 py-2 text-[11.5px] text-ink-soft"
                  >
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        onChange({
                          variants: form.variants.filter(
                            (candidate) => candidate.value !== variant.value,
                          ),
                        })
                      }
                      aria-label={`Remove ring size ${variant.value}`}
                      title={`Remove size ${variant.value}`}
                      className="min-w-7 rounded-pill bg-ink px-2 py-1 font-medium text-white outline-none focus-visible:shadow-[0_0_0_2px_var(--ink)] disabled:cursor-default"
                    >
                      {variant.value}
                    </button>
                    <input
                      value={variant.stock}
                      disabled={readOnly}
                      onChange={(event) => setVariantStock(variant.value, event.target.value)}
                      inputMode="numeric"
                      aria-label={`Ring size ${variant.value} stock`}
                      className="min-w-0 flex-1 rounded bg-surface px-2 py-1 text-right text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Pick the available ring sizes and enter stock for each one. Custom values such
                as 4.5, US 7, or Adjustable are supported. Shopify receives a Size variant for
                every selected value.
              </p>
            </div>
          ) : null}

          {form.variantKind === 'number' ? (
            <div className="mt-3">
              <label className="flex items-center gap-2 text-[11.5px] text-ink-soft">
                <span>Numbers 1 through</span>
                <input
                  value={form.variants.length || ''}
                  disabled={readOnly}
                  onChange={(event) =>
                    setNumberedChoiceCount(Number.parseInt(event.target.value || '0', 10) || 0)
                  }
                  inputMode="numeric"
                  aria-label="Number of numbered choices"
                  className="w-16 rounded-field bg-chip px-3 py-2 text-center text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                />
                <span className="text-muted-foreground">up to 100</span>
              </label>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                {form.variants.map((variant) => (
                  <label
                    key={variant.value}
                    className="flex items-center gap-2 rounded-field bg-chip px-2.5 py-2 text-[11.5px] text-ink-soft"
                  >
                    <span className="min-w-5 font-mono">#{variant.value}</span>
                    <input
                      value={variant.stock}
                      disabled={readOnly}
                      onChange={(event) => setVariantStock(variant.value, event.target.value)}
                      inputMode="numeric"
                      aria-label={`Number ${variant.value} stock`}
                      className="min-w-0 flex-1 rounded bg-surface px-2 py-1 text-right text-[12px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Customers will choose the number shown in the tray photograph. Every number
                is a separate Shopify variant with its own stock and the same product SKU.
              </p>
            </div>
          ) : null}

          {blockFor('variants') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('variants')!.message}
            </p>
          ) : null}
        </Field>

        <Field label="Price & stock">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <input
                ref={priceRef}
                value={form.price}
                disabled={readOnly}
                onChange={(event) => onChange({ price: event.target.value })}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Price in rupees"
                placeholder="₹ 0"
                className="w-full rounded-field bg-chip px-3.5 py-2.5 text-[14px] font-medium text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:font-normal placeholder:text-[#bfbfc4]"
              />
            </div>
            <div>
              {form.variantKind === 'none' ? (
                <input
                  value={form.stock}
                  disabled={readOnly}
                  onChange={(event) => onChange({ stock: event.target.value })}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label="Stock"
                  placeholder="Stock"
                  className="w-full rounded-field bg-chip px-3.5 py-2.5 text-[14px] font-medium text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
                />
              ) : (
                <output
                  aria-label="Total stock"
                  className="block w-full rounded-field bg-chip px-3.5 py-2.5 text-[14px] font-medium text-ink"
                >
                  {totalVariantStock} total
                </output>
              )}
            </div>
          </div>
          {blockFor('price') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('price')!.message}
            </p>
          ) : null}
          {blockFor('stock') ? (
            <label className="mt-2 flex items-start gap-2 text-[11.5px] leading-relaxed text-amber">
              <input
                type="checkbox"
                checked={form.allowZeroStock}
                disabled={readOnly}
                onChange={(event) => onChange({ allowZeroStock: event.target.checked })}
                className="mt-0.5 accent-[var(--ink)]"
              />
              <span>{blockFor('stock')!.message}</span>
            </label>
          ) : null}
        </Field>

        <Field label="Weight & title suffix">
          <div className="grid grid-cols-2 gap-2.5">
            <input
              value={form.weight}
              disabled={readOnly}
              onChange={(event) => onChange({ weight: event.target.value })}
              inputMode="numeric"
              autoComplete="off"
              aria-label="Weight in grams"
              placeholder={
                category?.defaultWeightG === null || category?.defaultWeightG === undefined
                  ? 'g — not set'
                  : `${category.defaultWeightG} g (default)`
              }
              className="w-full rounded-field bg-chip px-3.5 py-2.5 text-[13px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:text-[#bfbfc4]"
            />
            <input
              value={form.titleSuffix}
              disabled={readOnly}
              onChange={(event) => onChange({ titleSuffix: event.target.value })}
              autoComplete="off"
              aria-label="Title suffix"
              placeholder="(Adjustable)"
              className="w-full rounded-field bg-chip px-3.5 py-2.5 text-[13px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:text-[#bfbfc4]"
            />
          </div>
          {blockFor('weight') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('weight')!.message}
            </p>
          ) : null}
        </Field>

        {/* The one black feature card on the screen. */}
        <div className="mt-[18px]">
          {identity ? (
            <FeatureCard
              eyebrow={identity.predicted ? 'Will publish as (predicted)' : 'Reserved'}
              headline={`${identity.sku} · ${identity.title}`}
              meta={`/products/${identity.handle}`}
              footnote={
                identity.predicted
                  ? 'The number is allocated when you first Save draft or Publish, so it can move if somebody uses this category first.'
                  : `Reserved from the ${category?.name ?? 'category'} sequence. If its Shopify draft is deleted, reconciliation removes this Loupe draft and returns its photos to Pending; this retired number is never reused.`
              }
            />
          ) : (
            <div className="rounded-panel bg-chip px-[17px] py-[15px] text-[12.5px] text-muted-foreground">
              Choose a category to see the SKU, title and handle this will publish as.
            </div>
          )}
        </div>

        {children}
      </div>

      {/* Sticky. Publish never scrolls out of view (DESIGN.md · Interaction). */}
      <div className="sticky bottom-0 mt-3.5 flex gap-2 bg-surface pb-1 pt-3 shadow-[0_-14px_16px_-6px_var(--surface)]">
        {readOnly ? (
          <div
            className="flex flex-1 items-center justify-center gap-2 rounded-pill bg-ink py-3 text-[13px] font-medium text-white"
            role="status"
          >
            <span aria-hidden="true">✓</span>
            Listed · view only
          </div>
        ) : (
          <>
            <button
              type="submit"
              disabled={busy !== null || savingDraft}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-pill bg-ink py-3 text-[13px] font-medium text-white transition-colors',
                busy || savingDraft ? 'opacity-60' : 'hover:bg-[#242428]',
              )}
            >
              {busy === 'publish' ? 'Publishing…' : 'Publish'}
              <kbd className="rounded bg-white/[0.18] px-1.5 py-px font-sans text-[10px]">↵</kbd>
            </button>
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={busy === 'publish' || savingDraft}
              title={
                dirty
                  ? 'Draft it — saves in Loupe instantly and sends a Shopify draft in the background'
                  : 'This product is drafted'
              }
              aria-live="polite"
              className="flex min-w-[108px] shrink-0 items-center justify-center gap-1.5 rounded-pill bg-chip px-4 text-[12px] font-medium text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-60"
            >
              <span aria-hidden="true">{savingDraft ? '·' : dirty ? '◔' : '✓'}</span>
              {savingDraft ? 'Drafting…' : dirty ? 'Draft' : 'Drafted'}
            </button>
          </>
        )}
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-[18px]">
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-2.5">{children}</div>
    </div>
  )
}

/**
 * A choice field that collapses to its one-line answer once made. Children
 * stay mounted while closed (the grid-rows trick) so inputs keep their state
 * and the open/close motion is a real animation, not a remount.
 */
function Disclosure({
  label,
  value,
  placeholder,
  open,
  attention = false,
  locked = false,
  onToggle,
  children,
}: {
  label: string
  value: string | null
  placeholder: string
  open: boolean
  attention?: boolean
  locked?: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="mt-[18px]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-field px-3.5 py-2.5 text-left transition-colors',
          open ? 'bg-chip' : 'bg-chip hover:bg-[#ebebeb]',
        )}
      >
        <span className="loupe-label shrink-0">{label}</span>
        {attention ? (
          <span className="size-1.5 shrink-0 rounded-full bg-amber" aria-label="Needs attention" />
        ) : null}
        <span
          className={cn(
            'ml-auto min-w-0 truncate text-[12.5px]',
            value ? 'font-medium text-ink' : 'text-muted-foreground',
          )}
        >
          {locked ? '🔒 ' : ''}
          {value ?? placeholder}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className={cn('px-0.5 pb-1 pt-2.5', open ? '' : 'invisible')}>{children}</div>
        </div>
      </div>
    </div>
  )
}

function ColourSwatch({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      title={name}
      className={cn(
        'block shrink-0 rounded-full border border-black/15 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)]',
        className,
      )}
      style={{ background: colourSwatchBackground(name) }}
    />
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-full bg-surface text-[12px] text-ink-soft transition-colors hover:bg-white disabled:opacity-35"
    >
      {children}
    </button>
  )
}

/** Small helper the screen uses to show what a saved draft is worth. */
export function priceSummary(pricePaise: number | null): string {
  return formatPaise(pricePaise)
}
