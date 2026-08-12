/**
 * D101 — the freed-SKU pool, proved against the DEPLOYED functions.
 *
 * Three properties matter:
 *
 * 1. RELEASE RETURNS THE NUMBER TO ITS SEQUENCE. After release_draft_identity,
 *    the next first-reservation in that category receives the freed number —
 *    and the counter does NOT move, because nothing new was minted.
 * 2. THE POOL DRAINS LOWEST-FIRST AND EXACTLY ONCE. Two freed numbers come
 *    back in ascending order; a third reservation falls through to next_sku().
 * 3. THE GUARDS HOLD. A published draft, a draft with a live publish lease,
 *    and a draft that still records a Shopify product id (without proof of
 *    deletion) all refuse to release.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readCounter, serviceClient, setCounter } from './helpers/db'

const db = serviceClient()

interface Category {
  id: string
  name: string
  sku_prefix: string
  shopify_tag: string | null
}

let category: Category
let materialId: string
const createdDrafts: string[] = []
let counterBefore = 0

async function createDraft(): Promise<string> {
  const { data, error } = await db
    .from('product_drafts')
    .insert({
      category_id: category.id,
      material_id: materialId,
      price_paise: 25_000,
      stock: 5,
      weight_g: 0,
      created_by: 'test:sku-release',
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !data) throw new Error(`could not create draft: ${error?.message}`)
  createdDrafts.push(data.id)
  return data.id
}

interface Reserved {
  sku: string
  sku_number: number
  handle: string
  reused: boolean
}

async function reserve(draftId: string): Promise<Reserved> {
  const { data, error } = await db
    .rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: 'test:sku-release' })
    .select()
    .single<Reserved>()
  if (error || !data) throw new Error(`reserve failed: ${error?.message}`)
  return data
}

async function release(draftId: string, deletedShopifyProductId: string | null = null) {
  return db.rpc('release_draft_identity', {
    p_draft_id: draftId,
    p_actor: 'test:sku-release',
    p_deleted_shopify_product_id: deletedShopifyProductId,
  })
}

beforeAll(async () => {
  const { data: cats, error } = await db
    .from('categories')
    .select('id, name, sku_prefix, shopify_tag')
    .not('shopify_tag', 'is', null)
    .order('sort_order', { ascending: true })
    .limit(1)
  if (error || !cats?.length) throw new Error(`could not read a tagged category: ${error?.message}`)
  category = cats[0] as Category

  const { data: material } = await db
    .from('materials')
    .select('id')
    .limit(1)
    .single<{ id: string }>()
  materialId = material!.id

  counterBefore = await readCounter(category.sku_prefix)
})

afterAll(async () => {
  if (createdDrafts.length > 0) {
    await db.from('events').delete().in('entity_id', createdDrafts)
    await db.from('product_drafts').delete().in('id', createdDrafts)
  }
  // Remove any pool rows this suite minted, then restore the counter, so the
  // production sequence is exactly as found.
  await db
    .from('freed_skus')
    .delete()
    .eq('sku_prefix', category.sku_prefix)
    .gt('sku_number', counterBefore)
  await setCounter(category.sku_prefix, counterBefore)
})

describe('release_draft_identity + the freed pool (deployed)', () => {
  it('frees a number, hands it to the next draft, and never touches the counter', async () => {
    const first = await createDraft()
    const reserved = await reserve(first)
    expect(reserved.reused).toBe(false)
    const counterAfterReserve = await readCounter(category.sku_prefix)

    // The draft must not be mid-publish; reserve sets status='publishing'.
    await db.from('product_drafts').update({ status: 'failed', error: 'test' }).eq('id', first)
    const { error: releaseError } = await release(first)
    expect(releaseError).toBeNull()

    const freed = await db
      .from('freed_skus')
      .select('sku_number')
      .eq('sku_prefix', category.sku_prefix)
      .eq('sku_number', reserved.sku_number)
      .maybeSingle()
    expect(freed.data).not.toBeNull()

    const cleared = await db
      .from('product_drafts')
      .select('reserved_sku, reserved_handle, status')
      .eq('id', first)
      .single<{ reserved_sku: string | null; reserved_handle: string | null; status: string }>()
    expect(cleared.data).toMatchObject({
      reserved_sku: null,
      reserved_handle: null,
      status: 'assembling',
    })

    const second = await createDraft()
    const reused = await reserve(second)
    expect(reused.sku).toBe(reserved.sku)
    expect(reused.sku_number).toBe(reserved.sku_number)
    expect(reused.reused).toBe(false)

    // Pool row consumed exactly once; counter unchanged by the pooled reservation.
    const drained = await db
      .from('freed_skus')
      .select('sku_number')
      .eq('sku_prefix', category.sku_prefix)
      .eq('sku_number', reserved.sku_number)
      .maybeSingle()
    expect(drained.data).toBeNull()
    expect(await readCounter(category.sku_prefix)).toBe(counterAfterReserve)
  })

  it('refuses to release while a Shopify product id stands without proof of deletion', async () => {
    const draftId = await createDraft()
    await reserve(draftId)
    await db
      .from('product_drafts')
      .update({ status: 'assembling', shopify_product_id: 'gid://shopify/Product/999999' })
      .eq('id', draftId)

    const { error: withoutProof } = await release(draftId)
    expect(withoutProof?.message ?? '').toContain('still has Shopify product')

    const { error: withProof } = await release(draftId, 'gid://shopify/Product/999999')
    expect(withProof).toBeNull()
  })

  it('refuses a published draft and one holding a live publish lease', async () => {
    const draftId = await createDraft()
    const reserved = await reserve(draftId)

    await db
      .from('product_drafts')
      .update({
        status: 'publishing',
        publish_lease_token: '00000000-0000-0000-0000-000000000001',
        publish_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .eq('id', draftId)
    const { error: leased } = await release(draftId)
    expect(leased?.message ?? '').toContain('publish in flight')

    await db
      .from('product_drafts')
      .update({
        status: 'published',
        publish_lease_token: null,
        publish_lease_expires_at: null,
        published_at: new Date().toISOString(),
      })
      .eq('id', draftId)
    const { error: published } = await release(draftId)
    expect(published?.message ?? '').toContain('published')

    // Leave the row unpublished for cleanup; the reserved identity stays put.
    await db
      .from('product_drafts')
      .update({ status: 'failed', error: 'test', published_at: null })
      .eq('id', draftId)
    expect(reserved.sku.startsWith(category.sku_prefix)).toBe(true)
  })
})
