'use client'

import { useState, type RefObject } from 'react'

import { formatPaise } from '@/lib/console/money'
import type { PredictedIdentity } from '@/lib/console/preview'
import type {
  CategoryOption,
  ColourSuggestion,
  MaterialOption,
  PhotoSummary,
} from '@/lib/console/types'
import {
  defaultDescriptionText,
  DESCRIPTION_OVERRIDE_MAX_LENGTH,
} from '@/lib/publish/description'
import type { PublishBlock } from '@/lib/publish/validate'
import { cn } from '@/lib/utils'

import { ImageLightbox, type LightboxImage } from './ImageLightbox'
import { Chip, FeatureCard, SectionLabel } from './primitives'

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
 * The one place that needs help is the colour entry field, which is an input
 * inside the same form: Enter there adds the colour and stops the submit.
 */

export interface EditorImage {
  readonly intakeFileId: string
  readonly imageVersionId: string
}

export interface EditorForm {
  readonly categoryId: string | null
  readonly materialId: string | null
  readonly customMaterial: string
  /** Null uses the standard six bullets; a string is the operator's replacement. */
  readonly descriptionOverride: string | null
  /** Raw text. Parsed to paise by a string parser, never by a float. */
  readonly price: string
  readonly stock: string
  /** Empty means "use the category default" — NOT "zero" (D19). */
  readonly weight: string
  readonly titleSuffix: string
  readonly colours: readonly string[]
  readonly images: readonly EditorImage[]
  readonly allowZeroStock: boolean
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
  readonly dirty: boolean
  readonly priceRef: RefObject<HTMLInputElement | null>
  readonly onPublish: () => void
  readonly onSaveDraft: () => void
  readonly onDetach: ((intakeFileId: string) => void) | null
  readonly onMoveImage: (imageVersionId: string, delta: number) => void
  readonly onChooseVersion: (intakeFileId: string, imageVersionId: string) => void
  readonly onRedo: (intakeFileId: string, filename: string) => void
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
    dirty,
    priceRef,
    onPublish,
    onSaveDraft,
    onDetach,
    onMoveImage,
    onChooseVersion,
    onRedo,
    children,
  } = props

  const [colourDraft, setColourDraft] = useState('')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const openLightbox = (index: number) => setLightboxIndex(index)
  const category = categories.find((c) => c.id === form.categoryId) ?? null
  const selectedMaterial = materials.find((m) => m.id === form.materialId)?.name ?? null
  const materialName = form.customMaterial.trim() || selectedMaterial
  const defaultDescription = materialName ? defaultDescriptionText(materialName) : ''

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

  const photoByIntake = new Map(photos.map((p) => [p.intakeFileId, p]))
  const orderedImages = form.images
    .map((image) => ({ image, photo: photoByIntake.get(image.intakeFileId) }))
    .filter((row): row is { image: EditorImage; photo: PhotoSummary } => row.photo !== undefined)

  const hero = orderedImages[0]
  const heroVersion = hero?.photo.versions.find((v) => v.id === hero.image.imageVersionId)
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
      className="flex h-full flex-col"
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
        {/* Hero — the "larger review" case. Thumbnails are for the grid. */}
        <div className="relative aspect-[4/3] overflow-hidden rounded-panel bg-chip">
          {heroVersion?.full ? (
            <button
              // This sits inside the editor's <form>, whose submit publishes the
              // product — an implicit type="submit" here would publish on click.
              type="button"
              onClick={() => openLightbox(0)}
              aria-label="View this photograph full size"
              title="View full size"
              className="group absolute inset-0 cursor-zoom-in focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--ink)_inset]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived, private-bucket URL. */}
              <img
                src={heroVersion.full.url}
                alt={hero.photo.description ?? hero.photo.filename}
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
        </div>

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
                      className="rounded-pill bg-surface px-2.5 py-[7px] text-[10.5px] font-medium text-ink-soft transition-colors hover:bg-white disabled:opacity-40"
                    >
                      {busy === `redo:${row.image.intakeFileId}` ? 'Redoing…' : 'Redo image'}
                    </button>
                  </div>
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
                </div>
              </li>
            ))}
          </ul>
          {blockFor('images') ? (
            <p className="mt-2 text-[11.5px] text-amber">{blockFor('images')!.message}</p>
          ) : null}
        </div>

        {/* Category — the first of the two human judgements. */}
        <Field label="Category">
          <div className="flex flex-wrap gap-1.5">
            {categories.map((option) => (
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
                onClick={() => onChange({ categoryId: option.id })}
              >
                {option.name}
                {option.shopifyTag === null ? ' ·' : ''}
              </Chip>
            ))}
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
        </Field>

        <Field label="Material">
          <div className="flex flex-wrap gap-1.5">
            {materials.map((option) => (
              <Chip
                key={option.id}
                selected={option.id === form.materialId}
                disabled={readOnly}
                onClick={() => onChange({ materialId: option.id, customMaterial: '' })}
              >
                {option.name}
              </Chip>
            ))}
          </div>
          <input
            value={form.customMaterial}
            disabled={readOnly}
            maxLength={100}
            onChange={(event) =>
              onChange({ customMaterial: event.target.value, materialId: null })
            }
            onKeyDown={(event) => {
              // A custom material is still a choice field. Enter here must not
              // publish the form while the operator is typing it.
              if (event.key === 'Enter') event.preventDefault()
            }}
            aria-label="Custom material"
            placeholder="Or type a custom material"
            className="mt-2.5 w-full rounded-field bg-chip px-3.5 py-2.5 text-[13px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:text-[#bfbfc4]"
          />
          {blockFor('material') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('material')!.message}
            </p>
          ) : null}
        </Field>

        <Field label="Description">
          {form.descriptionOverride === null ? (
            <>
              <div className="whitespace-pre-line rounded-field bg-chip px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-soft">
                {defaultDescription ||
                  'Choose a material to preview the standard six-point description.'}
              </div>
              {!readOnly ? (
                <button
                  type="button"
                  disabled={!defaultDescription}
                  onClick={() => onChange({ descriptionOverride: defaultDescription })}
                  className="mt-2 rounded-pill bg-chip px-3 py-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-45"
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
                className="w-full resize-y rounded-field bg-chip px-3.5 py-3 text-[12px] leading-relaxed text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
              />
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => onChange({ descriptionOverride: null })}
                  className="mt-2 rounded-pill bg-chip px-3 py-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-[#ebebeb]"
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
        </Field>

        <Field label="Colours">
          <div className="flex flex-wrap gap-1.5">
            {form.colours.map((colour) => (
              <Chip
                key={colour}
                selected
                disabled={readOnly}
                title="Remove this colour"
                onClick={() => onChange({ colours: form.colours.filter((c) => c !== colour) })}
              >
                {colour}
              </Chip>
            ))}
            {colourSuggestions
              .filter((s) => !form.colours.some((c) => c.toLowerCase() === s.name.toLowerCase()))
              .slice(0, 6)
              .map((suggestion) => (
                <Chip
                  key={suggestion.name}
                  disabled={readOnly}
                  title={`Used ${suggestion.usageCount}× in ${category?.name ?? 'this category'}`}
                  onClick={() => onChange({ colours: [...form.colours, suggestion.name] })}
                >
                  {suggestion.name}
                </Chip>
              ))}
            <input
              value={colourDraft}
              disabled={readOnly}
              onChange={(event) => setColourDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // Enter inside a form submits it. Here it means "add this
                  // colour", so the submit — a publish — must be stopped.
                  event.preventDefault()
                  const name = colourDraft.trim()
                  if (name && !form.colours.some((c) => c.toLowerCase() === name.toLowerCase())) {
                    onChange({ colours: [...form.colours, name] })
                  }
                  setColourDraft('')
                } else if (event.key === 'Escape' && colourDraft) {
                  event.preventDefault()
                  setColourDraft('')
                }
              }}
              placeholder="+ add"
              aria-label="Add a colour"
              className="w-[86px] rounded-pill border border-dashed border-[#d5d5d5] bg-transparent px-3 py-[7px] text-[11.5px] text-ink-soft outline-none placeholder:text-muted-foreground"
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Colours become Shopify variants that share the product’s SKU. Names are tidied on
            save, so “rose gold” and “Rose  Gold” are one colour.
          </p>
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
              <input
                value={form.stock}
                disabled={readOnly}
                onChange={(event) => onChange({ stock: event.target.value })}
                inputMode="numeric"
                autoComplete="off"
                aria-label="Stock"
                className="w-full rounded-field bg-chip px-3.5 py-2.5 text-[14px] font-medium text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
              />
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
                  ? 'The number is allocated when you publish, so it can move if somebody publishes in this category first.'
                  : 'Allocated. A retry reuses this exact SKU and handle.'
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
              disabled={busy !== null}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-pill bg-ink py-3 text-[13px] font-medium text-white transition-colors',
                busy ? 'opacity-60' : 'hover:bg-[#242428]',
              )}
            >
              {busy === 'publish' ? 'Publishing…' : 'Publish'}
              <kbd className="rounded bg-white/[0.18] px-1.5 py-px font-sans text-[10px]">↵</kbd>
            </button>
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={busy !== null}
              title={
                dirty
                  ? 'Save as draft — reserves no SKU and publishes nothing'
                  : 'This draft is saved'
              }
              aria-live="polite"
              className="flex min-w-[108px] shrink-0 items-center justify-center gap-1.5 rounded-pill bg-chip px-4 text-[12px] font-medium text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-60"
            >
              <span aria-hidden="true">{busy === 'save' ? '·' : dirty ? '◔' : '✓'}</span>
              {busy === 'save' ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
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
