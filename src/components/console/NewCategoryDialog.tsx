'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import {
  createCategoryAction,
  searchShopifyTaxonomyAction,
  type ShopifyTaxonomyOption,
} from '@/app/console/actions'
import {
  suggestedSkuPrefix,
  suggestedTitleBase,
} from '@/lib/categories/validation'
import type { CategoryOption } from '@/lib/console/types'

export interface NewCategoryDialogProps {
  readonly onCancel: () => void
  readonly onCreated: (category: CategoryOption) => void
}

export function NewCategoryDialog({ onCancel, onCreated }: NewCategoryDialogProps) {
  const [name, setName] = useState('')
  const [skuPrefix, setSkuPrefix] = useState('')
  const [titleBase, setTitleBase] = useState('')
  const [shopifyTag, setShopifyTag] = useState('')
  const [taxonomySearch, setTaxonomySearch] = useState('')
  const [taxonomyResults, setTaxonomyResults] = useState<readonly ShopifyTaxonomyOption[]>([])
  const [taxonomy, setTaxonomy] = useState<ShopifyTaxonomyOption | null>(null)
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => nameRef.current?.focus(), [])

  const changeName = (nextName: string) => {
    const oldSuggestedPrefix = suggestedSkuPrefix(name)
    const oldSuggestedTitle = suggestedTitleBase(name)
    const nextSuggestedTitle = suggestedTitleBase(nextName)

    setName(nextName)
    if (!skuPrefix || skuPrefix === oldSuggestedPrefix) {
      setSkuPrefix(suggestedSkuPrefix(nextName))
    }
    if (!titleBase || titleBase === oldSuggestedTitle) setTitleBase(nextSuggestedTitle)
    if (!shopifyTag || shopifyTag === oldSuggestedTitle) setShopifyTag(nextSuggestedTitle)
    if (!taxonomySearch || taxonomySearch === name) setTaxonomySearch(nextName)
    setError(null)
  }

  const searchTaxonomy = async () => {
    setSearching(true)
    setError(null)
    setSearched(false)
    const result = await searchShopifyTaxonomyAction(taxonomySearch)
    setSearching(false)
    setSearched(true)
    if (!result.ok) {
      setTaxonomyResults([])
      setError(result.error.message)
      return
    }
    setTaxonomyResults(result.data)
    if (!result.data.some((option) => option.id === taxonomy?.id)) setTaxonomy(null)
  }

  const createCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreating(true)
    setError(null)
    const result = await createCategoryAction({
      name,
      skuPrefix,
      titleBase,
      shopifyTag,
      shopifyTaxonomyCategoryId: taxonomy?.id ?? '',
    })
    setCreating(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onCreated(result.data)
  }

  const nextNumber = `${skuPrefix.toUpperCase() || 'XX'}001`
  const nextTitle = `${titleBase || 'Product'} 001`

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-category-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) onCancel()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !creating) onCancel()
      }}
    >
      <form
        onSubmit={(event) => void createCategory(event)}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[620px] overflow-y-auto rounded-[24px] bg-surface p-6 shadow-2xl"
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="loupe-label">Catalogue setup</p>
            <h2 id="new-category-title" className="mt-1 text-[21px] font-medium tracking-[-0.02em]">
              Add a category
            </h2>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              This creates a permanent, independent SKU sequence. Existing SKU letters can never
              be reused for another category.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close new category"
            disabled={creating}
            onClick={onCancel}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-chip text-[18px] text-muted-foreground transition-colors hover:text-ink disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <TextField
            ref={nameRef}
            label="Category name"
            value={name}
            maxLength={80}
            placeholder="Waist Chains"
            onChange={changeName}
          />
          <TextField
            label="SKU letters"
            value={skuPrefix}
            maxLength={4}
            placeholder="WC"
            mono
            onChange={(value) => {
              setSkuPrefix(value.replace(/[^A-Za-z]/gu, '').toUpperCase())
              setError(null)
            }}
            help="2–4 letters. The first product below will be 001."
          />
          <TextField
            label="Product title before number"
            value={titleBase}
            maxLength={90}
            placeholder="Waist Chain"
            onChange={(value) => {
              setTitleBase(value)
              setError(null)
            }}
            help="Loupe adds 001, 002, 003… automatically."
          />
          <TextField
            label="Shopify collection tag"
            value={shopifyTag}
            maxLength={100}
            placeholder="Waist Chain"
            onChange={(value) => {
              setShopifyTag(value)
              setError(null)
            }}
            help="Exact spelling and casing used by the Shopify collection."
          />
        </div>

        <div className="mt-4 rounded-panel bg-chip p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <TextField
              label="Shopify product category"
              value={taxonomySearch}
              maxLength={80}
              placeholder="Body Jewelry"
              onChange={(value) => {
                setTaxonomySearch(value)
                setError(null)
              }}
              help="Search Shopify’s official categories, then choose one."
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              disabled={searching || creating}
              onClick={() => void searchTaxonomy()}
              className="h-[38px] shrink-0 rounded-pill bg-ink px-4 text-[11.5px] font-medium text-white transition-colors hover:bg-[#242428] disabled:opacity-50"
            >
              {searching ? 'Searching…' : 'Search Shopify'}
            </button>
          </div>

          {taxonomyResults.length > 0 ? (
            <div className="mt-3 grid gap-1.5" role="listbox" aria-label="Shopify product categories">
              {taxonomyResults.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={taxonomy?.id === option.id}
                  onClick={() => {
                    setTaxonomy(option)
                    setError(null)
                  }}
                  className={`rounded-[14px] px-3 py-2.5 text-left transition-colors ${
                    taxonomy?.id === option.id
                      ? 'bg-ink text-white'
                      : 'bg-white text-ink-soft hover:bg-[#f7f7f7]'
                  }`}
                >
                  <span className="block text-[11.5px] font-medium">{option.name}</span>
                  <span
                    className={`mt-0.5 block text-[10.5px] ${
                      taxonomy?.id === option.id ? 'text-white/60' : 'text-muted-foreground'
                    }`}
                  >
                    {option.fullName}
                  </span>
                </button>
              ))}
            </div>
          ) : searched && !searching ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              No exact product category found. Try a broader product type, such as “Body Jewelry”.
            </p>
          ) : null}
        </div>

        <div className="mt-4 rounded-panel bg-ink px-4 py-3 text-white">
          <p className="loupe-label text-white/45">First SKU preview</p>
          <p className="mt-1 text-[15px] font-medium">{nextNumber} · {nextTitle}</p>
          <p className="mt-1 text-[10.5px] text-white/55">
            Creating the category does not use this number. It is reserved only when a product is saved.
          </p>
        </div>

        {error ? (
          <div className="mt-4 rounded-panel bg-[#faf4e9] px-4 py-3 text-[11.5px] text-amber" role="alert">
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={creating}
            onClick={onCancel}
            className="rounded-pill bg-chip px-4 py-2 text-[11.5px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={creating}
            className="rounded-pill bg-ink px-4 py-2 text-[11.5px] font-medium text-white transition-colors hover:bg-[#242428] disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create and select'}
          </button>
        </div>
      </form>
    </div>
  )
}

interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly maxLength: number
  readonly placeholder: string
  readonly onChange: (value: string) => void
  readonly help?: string
  readonly mono?: boolean
  readonly className?: string
}

const TextField = function TextField(
  props: TextFieldProps & { readonly ref?: React.Ref<HTMLInputElement> },
) {
  const { label, value, maxLength, placeholder, onChange, help, mono, className, ref } = props
  return (
    <label className={className}>
      <span className="block text-[11px] font-medium text-ink-soft">{label}</span>
      <input
        ref={ref}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 h-[38px] w-full rounded-[12px] bg-white px-3 text-[12.5px] text-ink outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset] placeholder:text-[#bfbfc4] ${
          mono ? 'font-mono uppercase tracking-[0.08em]' : ''
        }`}
      />
      {help ? <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{help}</span> : null}
    </label>
  )
}
