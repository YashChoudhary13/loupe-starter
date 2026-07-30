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
import type { PublishBlock } from '@/lib/publish/validate'
import { cn } from '@/lib/utils'

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
  readonly blocks: readonly PublishBlock[]
  readonly busy: string | null
  readonly dirty: boolean
  readonly priceRef: RefObject<HTMLInputElement | null>
  readonly onPublish: () => void
  readonly onSaveDraft: () => void
  readonly onDetach: ((intakeFileId: string) => void) | null
  readonly onMoveImage: (imageVersionId: string, delta: number) => void
  readonly onChooseVersion: (intakeFileId: string, imageVersionId: string) => void
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
    blocks,
    busy,
    dirty,
    priceRef,
    onPublish,
    onSaveDraft,
    onDetach,
    onMoveImage,
    onChooseVersion,
    children,
  } = props

  const [colourDraft, setColourDraft] = useState('')
  const category = categories.find((c) => c.id === form.categoryId) ?? null

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

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) onPublish()
      }}
    >
      <div className="loupe-scroll min-h-0 flex-1 overflow-y-auto pr-1">
        {/* Hero — the "larger review" case. Thumbnails are for the grid. */}
        <div className="relative aspect-[4/3] overflow-hidden rounded-panel bg-chip">
          {heroVersion?.full ? (
            // eslint-disable-next-line @next/next/no-img-element -- presigned, short-lived, private-bucket URL.
            <img
              src={heroVersion.full.url}
              alt={hero.photo.description ?? hero.photo.filename}
              className="absolute inset-0 size-full object-contain"
            />
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
                  <p className="truncate font-mono text-[11px] text-ink-soft">
                    {row.photo.filename}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {row.photo.versions.map((version) => (
                      <Chip
                        key={version.id}
                        selected={version.id === row.image.imageVersionId}
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
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={`Move ${row.photo.filename} earlier`}
                    disabled={index === 0}
                    onClick={() => onMoveImage(row.image.imageVersionId, -1)}
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    label={`Move ${row.photo.filename} later`}
                    disabled={index === orderedImages.length - 1}
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
                disabled={identityLocked && option.id !== form.categoryId}
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
                onClick={() => onChange({ materialId: option.id })}
              >
                {option.name}
              </Chip>
            ))}
          </div>
          {blockFor('material') ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber">
              {blockFor('material')!.message}
            </p>
          ) : null}
        </Field>

        <Field label="Colours">
          <div className="flex flex-wrap gap-1.5">
            {form.colours.map((colour) => (
              <Chip
                key={colour}
                selected
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
                  title={`Used ${suggestion.usageCount}× in ${category?.name ?? 'this category'}`}
                  onClick={() => onChange({ colours: [...form.colours, suggestion.name] })}
                >
                  {suggestion.name}
                </Chip>
              ))}
            <input
              value={colourDraft}
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
