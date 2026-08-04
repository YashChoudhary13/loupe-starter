import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { serviceClient } from './helpers/db'

const db = serviceClient()
const ACTOR = 'test:category-management'
const PREFIX = 'ZT'
const NAME = 'Test Trinkets'

async function cleanup(): Promise<void> {
  const { data: category } = await db
    .from('categories')
    .select('id')
    .eq('sku_prefix', PREFIX)
    .maybeSingle<{ id: string }>()
  if (category) await db.from('events').delete().eq('entity_id', category.id)
  await db.from('events').delete().eq('actor', ACTOR)
  await db.from('sku_counters').delete().eq('sku_prefix', PREFIX)
  await db.from('categories').delete().eq('sku_prefix', PREFIX)
}

beforeAll(cleanup)
afterAll(cleanup)

describe('Waist Chains seed', () => {
  it('starts a new independent WC sequence at WC001', async () => {
    const [{ data: category, error: categoryError }, { data: counter, error: counterError }] =
      await Promise.all([
        db
          .from('categories')
          .select('name,sku_prefix,title_pattern,shopify_tag,shopify_taxonomy_category_id,default_weight_g,active')
          .eq('sku_prefix', 'WC')
          .single(),
        db.from('sku_counters').select('last_number').eq('sku_prefix', 'WC').single(),
      ])

    expect(categoryError).toBeNull()
    expect(counterError).toBeNull()
    expect(category).toMatchObject({
      name: 'Waist Chains',
      sku_prefix: 'WC',
      title_pattern: 'Waist Chain {n}',
      shopify_tag: 'Waist Chain',
      shopify_taxonomy_category_id: 'gid://shopify/TaxonomyCategory/aa-6-2',
      default_weight_g: 0,
      active: true,
    })
    expect(counter).toEqual({ last_number: 0 })
  })
})

describe('create_console_category', () => {
  it('atomically creates the category, zeroed counter, and audit event', async () => {
    const { data: categoryId, error } = await db.rpc('create_console_category', {
      p_name: NAME,
      p_sku_prefix: PREFIX,
      p_title_pattern: 'Test Trinket {n}',
      p_shopify_tag: 'Test Trinket',
      p_shopify_taxonomy_category_id: 'gid://shopify/TaxonomyCategory/aa-6-2',
      p_actor: ACTOR,
    })

    expect(error).toBeNull()
    expect(categoryId).toMatch(/^[0-9a-f-]{36}$/u)

    const [{ data: category }, { data: counter }, { data: event }] = await Promise.all([
      db
        .from('categories')
        .select('id,name,sku_prefix,title_pattern,shopify_tag,default_weight_g,default_stock,active')
        .eq('id', categoryId)
        .single(),
      db.from('sku_counters').select('last_number').eq('sku_prefix', PREFIX).single(),
      db
        .from('events')
        .select('event,actor,detail')
        .eq('entity_id', categoryId)
        .eq('event', 'category.created')
        .single(),
    ])

    expect(category).toMatchObject({
      name: NAME,
      sku_prefix: PREFIX,
      title_pattern: 'Test Trinket {n}',
      shopify_tag: 'Test Trinket',
      default_weight_g: 0,
      default_stock: 0,
      active: true,
    })
    expect(counter).toEqual({ last_number: 0 })
    expect(event).toMatchObject({
      event: 'category.created',
      actor: ACTOR,
      detail: { sku_prefix: PREFIX, first_sku: `${PREFIX}001` },
    })
  })

  it('refuses to reuse an existing SKU sequence', async () => {
    const { error } = await db.rpc('create_console_category', {
      p_name: 'Another Test Category',
      p_sku_prefix: PREFIX,
      p_title_pattern: 'Another Test {n}',
      p_shopify_tag: 'Another Test',
      p_shopify_taxonomy_category_id: 'gid://shopify/TaxonomyCategory/aa-6-2',
      p_actor: ACTOR,
    })

    expect(error?.code).toBe('23505')
    const { count } = await db
      .from('categories')
      .select('*', { count: 'exact', head: true })
      .eq('sku_prefix', PREFIX)
    expect(count).toBe(1)
  })
})
