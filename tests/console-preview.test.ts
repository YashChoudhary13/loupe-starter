/**
 * Phase 4 · criterion 8 — the preview must not lie, and must not allocate.
 *
 * The console shows `SKU · title · handle` before the operator presses Publish
 * (hard rule 8), computed in TypeScript from `sku_counters.last_number`. The real
 * identity comes from the deployed `public.reserve_draft_identity()`. Two
 * implementations of one rule drift, so every configured category is computed
 * BOTH ways here and compared — including Nose Pins, whose tag is unconfirmed and
 * which therefore cannot be reserved at all.
 *
 * The second property is the one that is easy to get wrong by accident: rendering
 * the preview, and saving a draft, must move no counter. A preview that quietly
 * burnt a number would open a gap for every operator who changed their mind about
 * a category.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { predictIdentity } from '@/lib/console/preview'
import { formatSku, renderTitle, slugifyHandle } from '@/lib/publish/identity'

import { readCounter, serviceClient, setCounter } from './helpers/db'

const db = serviceClient()

interface Category {
  id: string
  name: string
  sku_prefix: string
  title_pattern: string
  shopify_tag: string | null
}

let categories: Category[] = []
let materialId: string
const createdDrafts: string[] = []
const counterBefore = new Map<string, number>()

async function createDraft(categoryId: string, suffix: string | null): Promise<string> {
  const { data, error } = await db
    .from('product_drafts')
    .insert({
      category_id: categoryId,
      material_id: materialId,
      price_paise: 50_000,
      stock: 5,
      weight_g: 0,
      title_suffix: suffix,
      created_by: 'test:console-preview',
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !data) throw new Error(`could not create draft: ${error?.message}`)
  createdDrafts.push(data.id)
  return data.id
}

beforeAll(async () => {
  const { data: cats, error } = await db
    .from('categories')
    .select('id, name, sku_prefix, title_pattern, shopify_tag')
    .order('sort_order', { ascending: true })
  if (error || !cats) throw new Error(`could not read categories: ${error?.message}`)
  categories = cats as Category[]

  const { data: material } = await db
    .from('materials')
    .select('id')
    .eq('name', '316L')
    .single<{ id: string }>()
  materialId = material!.id

  for (const c of categories) counterBefore.set(c.sku_prefix, await readCounter(c.sku_prefix))
})

afterAll(async () => {
  if (createdDrafts.length > 0) {
    await db.from('events').delete().in('entity_id', createdDrafts)
    await db.from('product_drafts').delete().in('id', createdDrafts)
  }
  for (const [prefix, value] of counterBefore) await setCounter(prefix, value)
})

describe('predictIdentity (pure)', () => {
  it('predicts the NEXT number, which is last_number + 1', () => {
    const predicted = predictIdentity({
      skuPrefix: 'NK',
      titlePattern: 'Necklace {n}',
      lastNumber: 970,
      titleSuffix: null,
      reservedSku: null,
      reservedHandle: null,
    })
    expect(predicted).toEqual({
      sku: 'NK971',
      skuNumber: 971,
      title: 'Necklace 971',
      handle: 'necklace-971',
      predicted: true,
    })
  })

  it('pads to a minimum of three digits, in the SKU and in the title', () => {
    const low = predictIdentity({
      skuPrefix: 'AK',
      titlePattern: 'Anklets {n} (Single Piece)',
      lastNumber: 86,
      titleSuffix: null,
      reservedSku: null,
      reservedHandle: null,
    })
    expect(low.sku).toBe('AK087')
    expect(low.title).toBe('Anklets 087 (Single Piece)')
    expect(low.handle).toBe('anklets-087-single-piece')

    // Past 999 it widens rather than truncating — the lpad trap from D20.
    const high = predictIdentity({
      skuPrefix: 'NK',
      titlePattern: 'Necklace {n}',
      lastNumber: 999,
      titleSuffix: null,
      reservedSku: null,
      reservedHandle: null,
    })
    expect(high.sku).toBe('NK1000')
    expect(high.title).toBe('Necklace 1000')
  })

  it('folds the title suffix into the title and the handle', () => {
    const predicted = predictIdentity({
      skuPrefix: 'ER',
      titlePattern: 'Earrings {n}',
      lastNumber: 453,
      titleSuffix: '(Huggies)',
      reservedSku: null,
      reservedHandle: null,
    })
    expect(predicted.title).toBe('Earrings 454 (Huggies)')
    expect(predicted.handle).toBe('earrings-454-huggies')
  })

  it('stops predicting once an identity is reserved, and NEVER re-derives the handle', () => {
    // The handle is the idempotency key for productSet (hard rule 2). Recomputing
    // it after a corrected suffix would create a second Shopify product; the title
    // is re-rendered, exactly as reserve_draft_identity() does (D27).
    const reserved = predictIdentity({
      skuPrefix: 'NK',
      titlePattern: 'Necklace {n}',
      lastNumber: 9_999,
      titleSuffix: '(Adjustable)',
      reservedSku: 'NK005',
      reservedHandle: 'necklace-005',
    })
    expect(reserved.predicted).toBe(false)
    expect(reserved.sku).toBe('NK005')
    expect(reserved.skuNumber).toBe(5)
    expect(reserved.handle).toBe('necklace-005')
    expect(reserved.title).toBe('Necklace 005 (Adjustable)')
  })
})

describe('the preview against the deployed reservation', () => {
  it('agrees with reserve_draft_identity() for EVERY configured category', async () => {
    for (const category of categories) {
      const lastNumber = await readCounter(category.sku_prefix)
      const suffix = category.sku_prefix === 'ER' ? '(Huggies)' : null

      const predicted = predictIdentity({
        skuPrefix: category.sku_prefix,
        titlePattern: category.title_pattern,
        lastNumber,
        titleSuffix: suffix,
        reservedSku: null,
        reservedHandle: null,
      })

      const draftId = await createDraft(category.id, suffix)
      const { data, error } = await db
        .rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: 'test:console-preview' })
        .select()
        .single<{ sku: string; sku_number: number; handle: string; title: string }>()

      if (category.shopify_tag === null) {
        // Nose Pins. The preview still renders — the operator has to be able to
        // SEE what the category would produce — but publishing is refused, so
        // there is nothing to compare against and no number was taken (D23).
        expect(error?.message, category.name).toMatch(/no confirmed Shopify tag/)
        expect(await readCounter(category.sku_prefix)).toBe(lastNumber)
        expect(predicted.sku).toBe(formatSku(category.sku_prefix, lastNumber + 1))
        continue
      }

      expect(error, `${category.sku_prefix}: ${error?.message}`).toBeNull()
      expect(predicted.sku, category.name).toBe(data!.sku)
      expect(predicted.skuNumber, category.name).toBe(data!.sku_number)
      expect(predicted.title, category.name).toBe(data!.title)
      expect(predicted.handle, category.name).toBe(data!.handle)

      // And the same values a second way, straight from the formatters, so a
      // shared bug in predictIdentity cannot make both sides agree wrongly.
      expect(data!.sku).toBe(formatSku(category.sku_prefix, data!.sku_number))
      expect(data!.title).toBe(renderTitle(category.title_pattern, data!.sku_number, suffix))
      expect(data!.handle).toBe(slugifyHandle(data!.title))
    }
  })

  it('rendering the preview a hundred times moves no counter', async () => {
    const before = new Map<string, number>()
    for (const category of categories) {
      before.set(category.sku_prefix, await readCounter(category.sku_prefix))
    }

    for (let i = 0; i < 100; i += 1) {
      for (const category of categories) {
        predictIdentity({
          skuPrefix: category.sku_prefix,
          titlePattern: category.title_pattern,
          lastNumber: before.get(category.sku_prefix)!,
          titleSuffix: i % 2 === 0 ? '(Adjustable)' : null,
          reservedSku: null,
          reservedHandle: null,
        })
      }
    }

    for (const category of categories) {
      expect(await readCounter(category.sku_prefix)).toBe(before.get(category.sku_prefix))
    }
  })

  it('saving a draft moves no counter either', async () => {
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const before = await readCounter('NK')
    const draftId = await createDraft(nk.id, null)

    for (const price of [7_500, 7_550, 75_000]) {
      const { error } = await db.rpc('save_product_draft', {
        p_draft_id: draftId,
        p_expected_updated_at: null,
        p_category_id: nk.id,
        p_material_id: materialId,
        p_title_suffix: '(Adjustable)',
        p_price_paise: price,
        p_weight_g: null,
        p_stock: 5,
        p_variant_kind: 'colour',
        p_variants: [{ value: 'Gold', stock: 5 }],
        p_images: [],
        p_actor: 'test:console-preview',
      })
      expect(error?.message).toBeUndefined()
    }

    expect(await readCounter('NK')).toBe(before)

    const { data: draft } = await db
      .from('product_drafts')
      .select('reserved_sku, reserved_handle, status')
      .eq('id', draftId)
      .single<{ reserved_sku: string | null; reserved_handle: string | null; status: string }>()
    expect(draft!.reserved_sku).toBeNull()
    expect(draft!.reserved_handle).toBeNull()
    expect(draft!.status).toBe('assembling')
  })
})
