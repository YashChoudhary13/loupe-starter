/**
 * The SKU / title / handle a publish will actually use.
 *
 * Two things are proved here, and both are about the same risk.
 *
 * 1. THE PREVIEW CANNOT LIE. Hard rule 8 requires the console to show the operator
 *    a resolved `SKU · title · handle` before they press Publish, so a wrong
 *    category is visible. That preview comes from TypeScript
 *    (`src/lib/publish/identity.ts`); the real thing comes from the deployed
 *    `public.reserve_draft_identity()`. Two implementations of one rule drift, and
 *    a preview that disagrees with what gets written is worse than no preview.
 *    So every case below is computed BOTH ways and compared.
 *
 * 2. RESERVATION IS A TRANSACTION. A retry must reuse the same SKU and handle
 *    (hard rule 2), and a blocked publish must burn no number (hard rule 8).
 *
 * These run against the REAL database, deliberately. Asserting against the
 * migration file on disk proves nothing about what is deployed — see D15.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  formatSku,
  padSkuNumber,
  paiseToShopifyPrice,
  parseSku,
  renderTitle,
  slugifyHandle,
} from '@/lib/publish/identity'

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

async function createDraft(fields: {
  categoryId: string
  price_paise: number | null
  stock?: number
  weight_g?: number | null
  title_suffix?: string | null
  material?: boolean
}): Promise<string> {
  const { data, error } = await db
    .from('product_drafts')
    .insert({
      category_id: fields.categoryId,
      material_id: fields.material === false ? null : materialId,
      custom_material: null,
      description_override: null,
      price_paise: fields.price_paise,
      stock: fields.stock ?? 5,
      weight_g: fields.weight_g ?? 20,
      title_suffix: fields.title_suffix ?? null,
      created_by: 'test:publish-identity',
    })
    .select('id')
    .single<{ id: string }>()

  if (error || !data) throw new Error(`could not create draft: ${error?.message}`)
  createdDrafts.push(data.id)
  return data.id
}

async function reserve(draftId: string) {
  const { data, error } = await db
    .rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: 'test' })
    .select()
    .single<{
      sku: string
      sku_number: number
      handle: string
      title: string
      shopify_tag: string
      reused: boolean
    }>()
  return { data, error }
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
  // Put the counters back so the suite is repeatable. Done by direct UPDATE, not
  // through raise_sku_counter() — that function is monotone by design and cannot
  // lower anything, which is exactly the property being relied on elsewhere.
  for (const [prefix, value] of counterBefore) await setCounter(prefix, value)
})

describe('identity formatting (pure)', () => {
  it('pads the SKU to three digits, matching AK011 / RS221 / NK970', () => {
    expect(formatSku('AK', 11)).toBe('AK011')
    expect(formatSku('RS', 221)).toBe('RS221')
    expect(formatSku('NK', 970)).toBe('NK970')
    expect(formatSku('NK', 1)).toBe('NK001')
  })

  it('pads to a MINIMUM of three digits — it must never truncate', () => {
    // Postgres lpad(n, 3, '0') truncates: lpad('1000', 3, '0') is '100'. That would
    // have issued the 1000th necklace SKU NK100, colliding with an existing NK100.
    // padSkuNumber and public.pad_sku_number() both use a minimum, not a fixed width.
    expect(padSkuNumber(1000)).toBe('1000')
    expect(padSkuNumber(12_345)).toBe('12345')
    expect(formatSku('NK', 1000)).toBe('NK1000')
    // Still satisfies the reserved_sku CHECK, ^[A-Z]{2,4}[0-9]{3,}$
    expect(/^[A-Z]{2,4}[0-9]{3,}$/.test(formatSku('NK', 1000))).toBe(true)
  })

  it('pads the number in the TITLE too — confirmed against live data', () => {
    expect(renderTitle('Anklets {n} (Single Piece)', 87)).toBe('Anklets 087 (Single Piece)')
    expect(renderTitle('Nose Pin {n}', 4)).toBe('Nose Pin 004')
    expect(renderTitle('Rings {n}', 221)).toBe('Rings 221')
    expect(renderTitle('Necklace {n}', 970)).toBe('Necklace 970')
    expect(renderTitle('Necklace {n}', 1000)).toBe('Necklace 1000')
  })

  it('appends a suffix after a pattern that already has a parenthetical', () => {
    expect(renderTitle('Anklets {n} (Single Piece)', 87, '(Adjustable)')).toBe(
      'Anklets 087 (Single Piece) (Adjustable)',
    )
    expect(renderTitle('Earrings {n}', 12, '  (Huggies)  ')).toBe('Earrings 012 (Huggies)')
    expect(renderTitle('Earrings {n}', 12, '   ')).toBe('Earrings 012')
  })

  it('slugifies a handle the way Shopify would', () => {
    expect(slugifyHandle('Anklets 087 (Single Piece)')).toBe('anklets-087-single-piece')
    expect(slugifyHandle('Rings 221')).toBe('rings-221')
    expect(slugifyHandle('Necklace 005 (Light Rose gold)')).toBe('necklace-005-light-rose-gold')
  })

  it('round-trips a SKU', () => {
    expect(parseSku('AK011')).toEqual({ prefix: 'AK', number: 11 })
    expect(parseSku('  rs221 ')).toEqual({ prefix: 'RS', number: 221 })
    expect(parseSku('RS221-COPY')).toBeNull()
    expect(parseSku('221')).toBeNull()
    expect(parseSku('')).toBeNull()
  })

  it('converts paise to a rupee string without ever touching a float', () => {
    expect(paiseToShopifyPrice(75_000)).toBe('750.00')
    expect(paiseToShopifyPrice(1)).toBe('0.01')
    expect(paiseToShopifyPrice(99)).toBe('0.99')
    expect(paiseToShopifyPrice(100)).toBe('1.00')
    expect(paiseToShopifyPrice(123_456)).toBe('1234.56')
    expect(() => paiseToShopifyPrice(1.5)).toThrow(/integer/)
  })
})

describe('reserve_draft_identity (deployed function)', () => {
  it('agrees with the TypeScript preview for every category', async () => {
    // If these ever diverge, the operator's pre-publish preview is lying to them.
    for (const category of categories.filter((c) => c.shopify_tag !== null)) {
      const suffix = category.sku_prefix === 'ER' ? '(Huggies)' : null
      const draftId = await createDraft({ categoryId: category.id, price_paise: 50_000, title_suffix: suffix })

      const { data, error } = await reserve(draftId)
      expect(error, `${category.sku_prefix}: ${error?.message}`).toBeNull()

      const predictedTitle = renderTitle(category.title_pattern, data!.sku_number, suffix)
      expect(data!.sku).toBe(formatSku(category.sku_prefix, data!.sku_number))
      expect(data!.title).toBe(predictedTitle)
      expect(data!.handle).toBe(slugifyHandle(predictedTitle))
      expect(data!.shopify_tag).toBe(category.shopify_tag)
      expect(data!.reused).toBe(false)
    }
  })

  it('moves the draft to publishing and writes an event', async () => {
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const draftId = await createDraft({ categoryId: nk.id, price_paise: 90_000 })
    await reserve(draftId)

    const { data: draft } = await db
      .from('product_drafts')
      .select('status, reserved_sku, reserved_handle, error')
      .eq('id', draftId)
      .single<{ status: string; reserved_sku: string; reserved_handle: string; error: string | null }>()

    expect(draft!.status).toBe('publishing')
    expect(draft!.reserved_sku).toMatch(/^NK\d{3,}$/)
    expect(draft!.error).toBeNull()

    const { data: events } = await db
      .from('events')
      .select('event, detail')
      .eq('entity_id', draftId)
      .eq('event', 'publish.reserved')
    expect(events).toHaveLength(1)
    expect((events![0].detail as { sku: string }).sku).toBe(draft!.reserved_sku)
  })

  it('REUSES the identity on a second call and burns no second number', async () => {
    // This is what makes retry-after-failure idempotent (hard rule 2).
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const draftId = await createDraft({ categoryId: nk.id, price_paise: 90_000 })

    const first = await reserve(draftId)
    const counterAfterFirst = await readCounter('NK')

    const second = await reserve(draftId)

    expect(second.data!.sku).toBe(first.data!.sku)
    expect(second.data!.handle).toBe(first.data!.handle)
    expect(second.data!.reused).toBe(true)
    expect(first.data!.reused).toBe(false)
    expect(await readCounter('NK')).toBe(counterAfterFirst)
  })

  it('allocates DISTINCT consecutive numbers to concurrent reservations', async () => {
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const before = await readCounter('NK')

    const draftIds = await Promise.all(
      Array.from({ length: 12 }, () => createDraft({ categoryId: nk.id, price_paise: 40_000 })),
    )
    const results = await Promise.all(draftIds.map((id) => reserve(id)))

    const numbers = results.map((r) => r.data!.sku_number).sort((a, b) => a - b)
    expect(new Set(numbers).size).toBe(12)
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => before + 1 + i))
    expect(new Set(results.map((r) => r.data!.handle)).size).toBe(12)
  })

  it('BURNS NO NUMBER when the price is empty', async () => {
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const before = await readCounter('NK')
    const draftId = await createDraft({ categoryId: nk.id, price_paise: null })

    const { error } = await reserve(draftId)
    expect(error?.message).toMatch(/no price/i)
    expect(await readCounter('NK')).toBe(before)

    const { data: draft } = await db
      .from('product_drafts')
      .select('status, reserved_sku')
      .eq('id', draftId)
      .single<{ status: string; reserved_sku: string | null }>()
    expect(draft!.status).toBe('assembling')
    expect(draft!.reserved_sku).toBeNull()
  })

  it('pad_sku_number() and padSkuNumber() agree, including above 999', async () => {
    // The direct comparison. Postgres lpad(n, 3, '0') TRUNCATES above three digits
    // while String.padStart never does, so these two diverged silently until the
    // SQL side was given greatest(3, length(n)).
    for (const n of [1, 4, 87, 99, 100, 221, 970, 999, 1000, 1234, 12_345]) {
      const { data, error } = await db.rpc('pad_sku_number', { p_number: n })
      expect(error, `pad_sku_number(${n}): ${error?.message}`).toBeNull()
      expect(data, `pad_sku_number(${n})`).toBe(padSkuNumber(n))
    }
  })

  it('crosses 999 without losing a digit — the regression that bug would have caused', async () => {
    // With bare lpad(n, 3, '0') this reserved NK100, colliding with the necklace
    // that already holds NK100. Silently. In the one project that exists because
    // two products ended up on RS221.
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    await setCounter('NK', 999)

    const draftId = await createDraft({ categoryId: nk.id, price_paise: 30_000 })
    const { data, error } = await reserve(draftId)

    expect(error).toBeNull()
    expect(data!.sku_number).toBe(1000)
    expect(data!.sku).toBe('NK1000')
    expect(data!.title).toBe('Necklace 1000')
    expect(data!.handle).toBe('necklace-1000')
  })

  it('REFUSES a retry whose category changed under a frozen identity', async () => {
    // The identity is frozen (hard rule 2) but the title and tag are re-read from the
    // draft's current category on every call, so that a corrected title_suffix reaches
    // the retry. Without this guard those two combine into:
    //   SKU NK00x · title "Rings 00x" · tag Rings · handle necklace-00x
    // — a ring in the Rings collection carrying a number from the NECKLACE sequence,
    // while RS00x stays free for a real ring later. Nothing errors.
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const rs = categories.find((c) => c.sku_prefix === 'RS')!

    const draftId = await createDraft({ categoryId: nk.id, price_paise: 50_000 })
    const first = await reserve(draftId)
    expect(first.data!.sku).toMatch(/^NK\d{3,}$/)

    const nkCounterAfterFirst = await readCounter('NK')
    const rsCounterBefore = await readCounter('RS')

    // The operator realises it is a ring and switches the category.
    await db.from('product_drafts').update({ category_id: rs.id }).eq('id', draftId)

    const retry = await reserve(draftId)
    expect(retry.error?.message).toMatch(/holds NK\d+ from the NK sequence/i)
    expect(retry.error?.hint ?? '').toMatch(/Create a NEW draft/i)

    // Neither sequence moved, and the frozen identity was not rewritten.
    expect(await readCounter('NK')).toBe(nkCounterAfterFirst)
    expect(await readCounter('RS')).toBe(rsCounterBefore)

    const { data: draft } = await db
      .from('product_drafts')
      .select('reserved_sku, reserved_handle')
      .eq('id', draftId)
      .single<{ reserved_sku: string; reserved_handle: string }>()
    expect(draft!.reserved_sku).toBe(first.data!.sku)
    expect(draft!.reserved_handle).toBe(first.data!.handle)

    // Put it back so afterAll's cleanup and the counter restore behave.
    await db.from('product_drafts').update({ category_id: nk.id }).eq('id', draftId)
  })

  it('still allows a retry that only corrects the title suffix', async () => {
    // The guard must pin the CATEGORY, not freeze the title — otherwise fixing a typo
    // in a suffix would require abandoning the product.
    const nk = categories.find((c) => c.sku_prefix === 'NK')!
    const draftId = await createDraft({ categoryId: nk.id, price_paise: 50_000 })

    const first = await reserve(draftId)
    await db.from('product_drafts').update({ title_suffix: '(Adjustable)' }).eq('id', draftId)
    const retry = await reserve(draftId)

    expect(retry.error).toBeNull()
    expect(retry.data!.reused).toBe(true)
    expect(retry.data!.sku).toBe(first.data!.sku)
    expect(retry.data!.handle).toBe(first.data!.handle) // frozen
    expect(retry.data!.title).toBe(`${first.data!.title} (Adjustable)`) // corrected
  })

  it('refuses a category whose Shopify tag is unconfirmed, and burns no number', async () => {
    const np = categories.find((c) => c.sku_prefix === 'NP')
    expect(np, 'the NP / Nose Pins category should exist after Phase 2').toBeTruthy()
    expect(np!.shopify_tag).toBeNull()

    const before = await readCounter('NP')
    const draftId = await createDraft({ categoryId: np!.id, price_paise: 20_000 })

    const { error } = await reserve(draftId)
    expect(error?.message).toMatch(/no confirmed Shopify tag/i)
    expect(await readCounter('NP')).toBe(before)
  })
})

describe('raise_sku_counter (deployed function)', () => {
  it('raises, and is idempotent', async () => {
    const before = await readCounter('NK')
    const target = before + 250

    const { data: first, error: e1 } = await db.rpc('raise_sku_counter', {
      p_prefix: 'NK',
      p_to: target,
    })
    expect(e1).toBeNull()
    expect(first).toBe(target)

    const { data: second } = await db.rpc('raise_sku_counter', { p_prefix: 'NK', p_to: target })
    expect(second).toBe(target)
  })

  it('NEVER lowers — this is the property seed:counters depends on', async () => {
    const current = await readCounter('NK')
    const { data } = await db.rpc('raise_sku_counter', { p_prefix: 'NK', p_to: 1 })
    expect(data).toBe(current)
    expect(await readCounter('NK')).toBe(current)
  })

  it('raises on an unknown prefix rather than inventing a sequence', async () => {
    const { error } = await db.rpc('raise_sku_counter', { p_prefix: 'ZZ', p_to: 5 })
    expect(error?.message).toMatch(/unknown SKU prefix ZZ/i)

    const { data } = await db.from('sku_counters').select('sku_prefix').eq('sku_prefix', 'ZZ')
    expect(data).toEqual([])
  })
})
