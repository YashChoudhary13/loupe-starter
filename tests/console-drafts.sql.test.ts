/**
 * Phase 4 · criteria 5, 8, 9, 12 and 15 — the console's write path, against the
 * DEPLOYED database.
 *
 * The three races the console can lose are all decided in Postgres, so this is
 * where they have to be proved. Mocks cannot show that two concurrent claims of
 * the same photograph serialise on a row lock, and the migration file on disk is
 * not evidence about what is deployed (D15).
 *
 * These rows are COMMITTED rather than wrapped in one rolled-back transaction:
 * the grouping and double-publish races need two genuinely concurrent
 * connections, and two connections cannot see one another's uncommitted work.
 * Everything is cleaned up in afterAll and every fixture is prefixed so a failed
 * run is identifiable.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readCounter, serviceClient, setCounter } from './helpers/db'

const db = serviceClient()
const RUN = randomUUID().slice(0, 8)
const ACTOR = 'test:console-drafts'

interface Fixture {
  intakeFileId: string
  originalVersionId: string
  generatedVersionId: string
  filename: string
}

let categoryId: string
let otherCategoryId: string
let noseCategoryId: string
let materialId: string
const fixtures: Fixture[] = []
const createdDraftIds = new Set<string>()
let counterBefore = 0

async function makePhoto(index: number): Promise<Fixture> {
  const filename = `phase4-${RUN}-${index}.png`
  const { data: file, error } = await db
    .from('intake_files')
    .insert({
      drive_file_id: `drive-${RUN}-${index}`,
      filename,
      status: 'enhanced',
      bytes: 1_234,
      enhanced_at: new Date().toISOString(),
      // `intake_files_description_is_complete` is all-or-nothing: a cached
      // description must arrive with the model, the timestamp and the actual
      // cost that produced it, or not at all.
      product_description: `A single test piece number ${index}, plain and factual.`,
      description_model: 'openai/gpt-5.6-sol',
      described_at: new Date().toISOString(),
      description_cost_usd: 0.015,
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !file) throw new Error(`fixture intake_files: ${error?.message}`)

  const { data: versions, error: versionError } = await db
    .from('image_versions')
    .insert([
      {
        intake_file_id: file.id,
        version_no: 0,
        kind: 'original',
        storage_key: `originals/${file.id}.png`,
        thumb_key: null,
        is_selected: false,
      },
      {
        intake_file_id: file.id,
        version_no: 1,
        kind: 'generated',
        storage_key: `versions/${file.id}/v1.png`,
        thumb_key: `versions/${file.id}/v1_thumb.webp`,
        prompt_text: 'test prompt',
        model: 'openai/gpt-image-2',
        cost_usd: 0.078,
        description_injected: true,
        description_missing: false,
        is_selected: true,
      },
    ])
    .select('id, kind')
  if (versionError || !versions) throw new Error(`fixture image_versions: ${versionError?.message}`)

  const original = versions.find((v) => (v as { kind: string }).kind === 'original') as { id: string }
  const generated = versions.find((v) => (v as { kind: string }).kind === 'generated') as { id: string }

  const fixture: Fixture = {
    intakeFileId: file.id,
    originalVersionId: original.id,
    generatedVersionId: generated.id,
    filename,
  }
  fixtures.push(fixture)
  return fixture
}

async function createDraft(intakeFileIds: readonly string[], category = categoryId) {
  const result = await db.rpc('create_product_draft', {
    p_category_id: category,
    p_intake_file_ids: intakeFileIds,
    p_actor: ACTOR,
  })
  if (result.data) createdDraftIds.add(result.data as string)
  return result
}

async function draftRow(id: string) {
  const { data } = await db
    .from('product_drafts')
    .select('id, status, category_id, material_id, custom_material, description_override, price_paise, stock, variant_kind, weight_g, title_suffix, reserved_sku, updated_at, publish_lease_token, publish_lease_expires_at')
    .eq('id', id)
    .single()
  return data as Record<string, unknown>
}

async function intakeRow(id: string) {
  const { data } = await db
    .from('intake_files')
    .select('id, status, product_draft_id, grouped_at')
    .eq('id', id)
    .single()
  return data as { id: string; status: string; product_draft_id: string | null; grouped_at: string | null }
}

async function draftImages(draftId: string) {
  const { data } = await db
    .from('product_draft_images')
    .select('image_version_id, position, shopify_media_id, colour_id, colours ( name )')
    .eq('product_draft_id', draftId)
    .order('position', { ascending: true })
  return (data ?? []) as {
    image_version_id: string
    position: number
    shopify_media_id: string | null
    colour_id: string | null
    colours: { name: string } | { name: string }[] | null
  }[]
}

async function eventNames(entityId: string): Promise<string[]> {
  const { data } = await db
    .from('events')
    .select('event')
    .eq('entity_id', entityId)
    .order('created_at', { ascending: true })
  return (data ?? []).map((row) => (row as { event: string }).event)
}

beforeAll(async () => {
  const { data: cats } = await db.from('categories').select('id, sku_prefix')
  const categories = (cats ?? []) as { id: string; sku_prefix: string }[]
  categoryId = categories.find((c) => c.sku_prefix === 'NK')!.id
  otherCategoryId = categories.find((c) => c.sku_prefix === 'RS')!.id
  noseCategoryId = categories.find((c) => c.sku_prefix === 'NP')!.id

  const { data: material } = await db.from('materials').select('id').eq('name', '316L').single<{ id: string }>()
  materialId = material!.id

  counterBefore = await readCounter('NK')

  for (let index = 0; index < 11; index += 1) await makePhoto(index)
})

afterAll(async () => {
  const intakeIds = fixtures.map((f) => f.intakeFileId)
  const draftIds = [...createdDraftIds]

  // ORDER MATTERS, and both wrong orders fail — in opposite directions.
  //
  //   intake_files → image_versions        is ON DELETE CASCADE
  //   product_draft_images → image_versions is ON DELETE RESTRICT
  //   intake_files.product_draft_id         is ON DELETE SET NULL
  //   …and `intake_files_grouped_has_draft` requires a draft while grouped.
  //
  // So deleting the intake rows first cascades away versions a draft image still
  // points at (RESTRICT refuses it), and deleting the drafts first nulls
  // product_draft_id on rows that are still `grouped` (the CHECK refuses that).
  // Cutting the join table first breaks the deadlock.
  //
  // Getting this wrong is silent unless the error is checked: the fixtures
  // survive — including drafts holding reserved SKUs — the counter is reset
  // beneath them, and the NEXT run collides on product_drafts_reserved_sku_key.
  if (draftIds.length) {
    const { error } = await db.from('product_draft_images').delete().in('product_draft_id', draftIds)
    if (error) throw new Error(`fixture cleanup (product_draft_images): ${error.message}`)
  }
  if (intakeIds.length) {
    const { error } = await db.from('intake_files').delete().in('id', intakeIds)
    if (error) throw new Error(`fixture cleanup (intake_files): ${error.message}`)
  }
  if (draftIds.length) {
    const { error } = await db.from('product_drafts').delete().in('id', draftIds)
    if (error) throw new Error(`fixture cleanup (product_drafts): ${error.message}`)
  }
  const orphanIds = [...intakeIds, ...draftIds]
  if (orphanIds.length) await db.from('events').delete().in('entity_id', orphanIds)
  await db.from('events').delete().eq('actor', ACTOR)

  await setCounter('NK', counterBefore)
})

describe('grouping', () => {
  it('groups one photograph, and one is a valid product', async () => {
    const photo = fixtures[0]
    const { data: draftId, error } = await createDraft([photo.intakeFileId])
    expect(error?.message).toBeUndefined()

    const intake = await intakeRow(photo.intakeFileId)
    expect(intake.status).toBe('grouped')
    expect(intake.product_draft_id).toBe(draftId)
    expect(intake.grouped_at).not.toBeNull()

    // Each photograph contributes its selected generated version by default.
    const images = await draftImages(draftId as string)
    expect(images).toHaveLength(1)
    expect(images[0].image_version_id).toBe(photo.generatedVersionId)
    expect(images[0].position).toBe(0)

    expect(await eventNames(photo.intakeFileId)).toContain('intake.grouped')
    expect(await eventNames(draftId as string)).toContain('draft.created')
  })

  it('groups several photographs into one product, in a deterministic order', async () => {
    const chosen = fixtures.slice(1, 4)
    const { data: draftId, error } = await createDraft(chosen.map((f) => f.intakeFileId))
    expect(error?.message).toBeUndefined()

    const images = await draftImages(draftId as string)
    expect(images.map((i) => i.position)).toEqual([0, 1, 2])
    expect(new Set(images.map((i) => i.image_version_id))).toEqual(
      new Set(chosen.map((f) => f.generatedVersionId)),
    )
  })

  it('THE RACE — two concurrent groupings of one photograph: exactly one wins', async () => {
    const contested = fixtures[4]

    const [a, b] = await Promise.all([
      createDraft([contested.intakeFileId], categoryId),
      createDraft([contested.intakeFileId], otherCategoryId),
    ])

    const winners = [a, b].filter((r) => r.error === null)
    const losers = [a, b].filter((r) => r.error !== null)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    // 55000 = object_not_in_prerequisite_state. The hint is what the operator reads.
    expect(losers[0].error!.code).toBe('55000')
    expect(losers[0].error!.hint).toMatch(/Another operator grouped/)

    // The photograph belongs to exactly one draft, and the loser's draft was
    // rolled back entirely rather than being left behind empty.
    const intake = await intakeRow(contested.intakeFileId)
    expect(intake.product_draft_id).toBe(winners[0].data)

    const { count } = await db
      .from('product_drafts')
      .select('id', { count: 'exact', head: true })
      .in('id', [a.data, b.data].filter((id): id is string => typeof id === 'string'))
    expect(count).toBe(1)
  })

  it('refuses to group a photograph that already belongs to a draft', async () => {
    const taken = fixtures[0]
    const { error } = await createDraft([taken.intakeFileId])
    expect(error?.code).toBe('55000')
  })

  it('attaches and detaches, returning the photograph to the queue', async () => {
    const [first, second] = [fixtures[5], fixtures[6]]
    const { data: draftId } = await createDraft([first.intakeFileId])

    const { error: attachError } = await db.rpc('attach_intake_file', {
      p_draft_id: draftId,
      p_intake_file_id: second.intakeFileId,
      p_actor: ACTOR,
    })
    expect(attachError?.message).toBeUndefined()
    expect((await draftImages(draftId as string)).map((i) => i.position)).toEqual([0, 1])

    const { error: detachError } = await db.rpc('detach_intake_file', {
      p_draft_id: draftId,
      p_intake_file_id: first.intakeFileId,
      p_actor: ACTOR,
    })
    expect(detachError?.message).toBeUndefined()

    const returned = await intakeRow(first.intakeFileId)
    expect(returned.status).toBe('enhanced')
    expect(returned.product_draft_id).toBeNull()
    expect(returned.grouped_at).toBeNull()
    expect(await eventNames(first.intakeFileId)).toContain('intake.ungrouped')

    // Positions stay contiguous from 0 so the Shopify order has no holes in it.
    const remaining = await draftImages(draftId as string)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].position).toBe(0)
    expect(remaining[0].image_version_id).toBe(second.generatedVersionId)
  })
})

describe('saving', () => {
  let draftId: string

  beforeAll(async () => {
    const chosen = fixtures.slice(7, 10)
    const { data } = await createDraft(chosen.map((f) => f.intakeFileId))
    draftId = data as string
  })

  async function save(overrides: Record<string, unknown> = {}) {
    const current = await draftRow(draftId)
    return db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: current.updated_at,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: '(Adjustable)',
      p_price_paise: 7_550,
      p_weight_g: null,
      p_stock: 12,
      p_variant_kind: 'colour',
      p_variants: [
        { value: 'gold', stock: 12 },
        { value: 'Rose  gold', stock: 4 },
      ],
      p_images: fixtures.slice(7, 10).map((f, index) => ({
        image_version_id: f.generatedVersionId,
        position: index,
      })),
      p_actor: ACTOR,
      ...overrides,
    })
  }

  it('persists fields, normalised colours, version choice and order', async () => {
    const { error } = await save()
    expect(error?.message).toBeUndefined()

    const draft = await draftRow(draftId)
    expect(draft.price_paise).toBe(7_550)
    // Parent stock stays compatible with the old shared-stock console; the
    // authoritative per-colour quantities are on the rows below.
    expect(draft.stock).toBe(12)
    expect(draft.variant_kind).toBe('colour')
    expect(draft.title_suffix).toBe('(Adjustable)')
    // NULL weight is preserved as NULL — "nobody has said" is a real state (D19).
    expect(draft.weight_g).toBeNull()

    const { data: variants } = await db
      .from('product_draft_variants')
      .select('position, option_value, stock')
      .eq('product_draft_id', draftId)
      .order('position', { ascending: true })
    const names = (variants ?? []).map((row) => row.option_value)
    // The database trigger normalises: "gold" and "Rose  gold" become
    // "Gold" and "Rose Gold" (D17). The console never does this itself.
    expect(names).toEqual(['Gold', 'Rose Gold'])
    expect((variants ?? []).map((row) => row.stock)).toEqual([12, 4])

    expect((await draftImages(draftId)).map((i) => i.position)).toEqual([0, 1, 2])
  })

  it('persists one optional Shopify variant image per selected colour', async () => {
    const { error } = await save({
      p_images: [
        {
          image_version_id: fixtures[7].generatedVersionId,
          position: 0,
          colour: 'gold',
        },
        {
          image_version_id: fixtures[8].generatedVersionId,
          position: 1,
          colour: 'Rose  gold',
        },
        { image_version_id: fixtures[9].generatedVersionId, position: 2, colour: null },
      ],
    })
    expect(error?.message).toBeUndefined()

    const images = await draftImages(draftId)
    const colourName = (image: (typeof images)[number]) => {
      const colour = Array.isArray(image.colours) ? image.colours[0] : image.colours
      return colour?.name ?? null
    }
    expect(images.map(colourName)).toEqual(['Gold', 'Rose Gold', null])

    const duplicate = await save({
      p_images: [
        {
          image_version_id: fixtures[7].generatedVersionId,
          position: 0,
          colour: 'Gold',
        },
        {
          image_version_id: fixtures[8].generatedVersionId,
          position: 1,
          colour: 'gold',
        },
      ],
    })
    expect(duplicate.error?.code).toBe('22023')
    expect(duplicate.error?.hint).toMatch(/one featured image per variant/i)

    const unknown = await save({
      p_images: [
        {
          image_version_id: fixtures[7].generatedVersionId,
          position: 0,
          colour: 'Blue',
        },
      ],
    })
    expect(unknown.error?.code).toBe('22023')
    expect(unknown.error?.hint).toMatch(/colour variants/i)
  })

  it('persists numbered choices with independent stock and derives the total', async () => {
    const { error } = await save({
      p_stock: 999,
      p_variant_kind: 'number',
      p_variants: [
        { value: '1', stock: 2 },
        { value: '2', stock: 0 },
        { value: '3', stock: 4 },
      ],
    })
    expect(error?.message).toBeUndefined()

    const draft = await draftRow(draftId)
    expect(draft.variant_kind).toBe('number')
    expect(draft.stock).toBe(4)

    const { data: variants } = await db
      .from('product_draft_variants')
      .select('position, option_value, stock, colour_id')
      .eq('product_draft_id', draftId)
      .order('position', { ascending: true })
    expect(variants).toEqual([
      { position: 0, option_value: '1', stock: 2, colour_id: null },
      { position: 1, option_value: '2', stock: 0, colour_id: null },
      { position: 2, option_value: '3', stock: 4, colour_id: null },
    ])
  })

  it('persists ring sizes with independent stock and normalises custom labels', async () => {
    const { error } = await save({
      p_stock: 999,
      p_variant_kind: 'size',
      p_variants: [
        { value: '6', stock: 2 },
        { value: '7.5', stock: 5 },
        { value: ' US   8 ', stock: 1 },
      ],
    })
    expect(error?.message).toBeUndefined()

    const draft = await draftRow(draftId)
    expect(draft.variant_kind).toBe('size')
    expect(draft.stock).toBe(5)

    const { data: variants } = await db
      .from('product_draft_variants')
      .select('position, option_value, stock, colour_id')
      .eq('product_draft_id', draftId)
      .order('position', { ascending: true })
    expect(variants).toEqual([
      { position: 0, option_value: '6', stock: 2, colour_id: null },
      { position: 1, option_value: '7.5', stock: 5, colour_id: null },
      { position: 2, option_value: 'US 8', stock: 1, colour_id: null },
    ])
  })

  it('keeps the deployed colour-only save contract working during rollout', async () => {
    const current = await draftRow(draftId)
    const { error } = await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: current.updated_at,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 7_550,
      p_weight_g: 0,
      p_stock: 9,
      // Deliberately the pre-feature payload: no p_variant_kind/p_variants.
      p_colours: ['silver'],
      p_images: [],
      p_actor: ACTOR,
    })
    expect(error?.message).toBeUndefined()

    const draft = await draftRow(draftId)
    expect(draft.variant_kind).toBe('colour')
    expect(draft.stock).toBe(9)
    const repeated = await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: draft.updated_at,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 7_550,
      p_weight_g: 0,
      p_stock: draft.stock,
      p_colours: ['Silver'],
      p_images: [],
      p_actor: ACTOR,
    })
    expect(repeated.error?.message).toBeUndefined()
    expect((await draftRow(draftId)).stock).toBe(9)
    const { data: variants } = await db
      .from('product_draft_variants')
      .select('option_value, stock')
      .eq('product_draft_id', draftId)
    expect(variants).toEqual([{ option_value: 'Silver', stock: 9 }])
  })

  it('rejects ambiguous duplicate colours and sizes, and invalid tray numbers', async () => {
    const duplicate = await save({
      p_variant_kind: 'colour',
      p_variants: [
        { value: 'rose gold', stock: 1 },
        { value: 'Rose  Gold', stock: 2 },
      ],
    })
    expect(duplicate.error?.code).toBe('22023')
    expect(duplicate.error?.hint).toMatch(/Each colour should appear once/)

    const duplicateSize = await save({
      p_variant_kind: 'size',
      p_variants: [
        { value: 'US 7', stock: 1 },
        { value: 'us   7', stock: 2 },
      ],
    })
    expect(duplicateSize.error?.code).toBe('22023')
    expect(duplicateSize.error?.hint).toMatch(/Each size should appear once/)

    const invalidNumber = await save({
      p_variant_kind: 'number',
      p_variants: [{ value: '01', stock: 1 }],
    })
    expect(invalidNumber.error?.code).toBe('22023')
    expect(invalidNumber.error?.hint).toMatch(/numbered-choice count/)
  })

  it('stores a one-off material and plain-text description without changing suggestions', async () => {
    const { error } = await save({
      p_material_id: null,
      p_custom_material: '  Sterling   Silver  ',
      p_description_override: '  A limited one-off piece.  ',
    })
    expect(error?.message).toBeUndefined()

    const draft = await draftRow(draftId)
    expect(draft.material_id).toBeNull()
    expect(draft.custom_material).toBe('Sterling Silver')
    expect(draft.description_override).toBe('A limited one-off piece.')

    const both = await save({
      p_material_id: materialId,
      p_custom_material: 'Sterling Silver',
    })
    expect(both.error?.code).toBe('22023')
    expect(both.error?.hint).toMatch(/Clear the custom material/)
  })

  it('reorders images and chooses the original for one source', async () => {
    const reordered = [
      { image_version_id: fixtures[9].generatedVersionId, position: 0 },
      { image_version_id: fixtures[8].originalVersionId, position: 1 },
      { image_version_id: fixtures[7].generatedVersionId, position: 2 },
    ]
    const { error } = await save({ p_images: reordered })
    expect(error?.message).toBeUndefined()

    const images = await draftImages(draftId)
    expect(images.map((i) => i.image_version_id)).toEqual([
      fixtures[9].generatedVersionId,
      fixtures[8].originalVersionId,
      fixtures[7].generatedVersionId,
    ])
  })

  it('preserves a recorded Shopify media id across a reorder', async () => {
    // This is what stops a re-publish uploading the same photograph twice (D47).
    await db.rpc('record_shopify_media', {
      p_draft_id: draftId,
      p_media: [{ image_version_id: fixtures[9].generatedVersionId, media_id: 'gid://shopify/MediaImage/1' }],
      p_actor: ACTOR,
    })

    const { error } = await save({
      p_images: [
        { image_version_id: fixtures[7].generatedVersionId, position: 0 },
        { image_version_id: fixtures[8].originalVersionId, position: 1 },
        { image_version_id: fixtures[9].generatedVersionId, position: 2 },
      ],
    })
    expect(error?.message).toBeUndefined()

    const images = await draftImages(draftId)
    const moved = images.find((i) => i.image_version_id === fixtures[9].generatedVersionId)!
    expect(moved.position).toBe(2)
    expect(moved.shopify_media_id).toBe('gid://shopify/MediaImage/1')
  })

  it('THE SAVE RACE — a stale editor cannot overwrite a newer save', async () => {
    const stale = (await draftRow(draftId)).updated_at

    const fresh = await save({ p_price_paise: 20_000 })
    expect(fresh.error?.message).toBeUndefined()
    expect((await draftRow(draftId)).price_paise).toBe(20_000)

    const late = await save({ p_expected_updated_at: stale, p_price_paise: 999 })
    expect(late.error?.code).toBe('55000')
    expect(late.error?.hint).toMatch(/saved this draft after you opened it/)
    // The newer value survives, and nothing the stale tab typed was written.
    expect((await draftRow(draftId)).price_paise).toBe(20_000)
  })

  it('refuses an image version that belongs to a different product', async () => {
    const foreign = fixtures[0].generatedVersionId
    const { error } = await save({
      p_images: [{ image_version_id: foreign, position: 0 }],
    })
    expect(error?.code).toBe('22023')
    expect(error?.hint).toMatch(/grouped into this draft/)
  })

  it('reserves nothing and moves no counter, however many times it is saved', async () => {
    const before = await readCounter('NK')
    for (let i = 0; i < 5; i += 1) await save({ p_price_paise: 7_500 + i })
    expect(await readCounter('NK')).toBe(before)
    expect((await draftRow(draftId)).reserved_sku).toBeNull()
    expect(await eventNames(draftId)).toContain('draft.saved')
  })
})

describe('the publish lease', () => {
  let draftId: string

  beforeAll(async () => {
    const photo = await makePhoto(100)
    const { data } = await createDraft([photo.intakeFileId])
    draftId = data as string
  })

  it('refuses a second publish while one is in flight — the double-submit guard', async () => {
    const [a, b] = await Promise.all([
      db.rpc('begin_draft_publish', { p_draft_id: draftId, p_lease_seconds: 120, p_actor: ACTOR }),
      db.rpc('begin_draft_publish', { p_draft_id: draftId, p_lease_seconds: 120, p_actor: ACTOR }),
    ])

    const held = [a, b].filter((r) => r.error === null)
    const refused = [a, b].filter((r) => r.error !== null)
    expect(held).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0].error!.code).toBe('55000')
    expect(refused[0].error!.hint).toMatch(/already running/)

    // Fencing: only the token holder may release it.
    const wrong = await db.rpc('end_draft_publish', {
      p_draft_id: draftId,
      p_lease_token: '00000000-0000-4000-8000-000000000000',
    })
    expect(wrong.data).toBe(false)
    expect((await draftRow(draftId)).publish_lease_token).toBe(held[0].data)

    const right = await db.rpc('end_draft_publish', {
      p_draft_id: draftId,
      p_lease_token: held[0].data as string,
    })
    expect(right.data).toBe(true)
    expect((await draftRow(draftId)).publish_lease_token).toBeNull()
  })

  it('an EXPIRED lease is reclaimable, so a crashed publish self-heals', async () => {
    const first = await db.rpc('begin_draft_publish', {
      p_draft_id: draftId,
      p_lease_seconds: 1,
      p_actor: ACTOR,
    })
    expect(first.error).toBeNull()

    // Simulate the crash: the holder never comes back. Expire the lease the way
    // wall-clock time would.
    await db
      .from('product_drafts')
      .update({ publish_lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq('id', draftId)

    const retry = await db.rpc('begin_draft_publish', {
      p_draft_id: draftId,
      p_lease_seconds: 120,
      p_actor: ACTOR,
    })
    expect(retry.error).toBeNull()
    expect(retry.data).not.toBe(first.data)

    // The stale holder cannot unlock the attempt that replaced it.
    const stale = await db.rpc('end_draft_publish', {
      p_draft_id: draftId,
      p_lease_token: first.data as string,
    })
    expect(stale.data).toBe(false)

    await db.rpc('end_draft_publish', { p_draft_id: draftId, p_lease_token: retry.data as string })
  })
})

describe('the invariants the console must not be able to route around', () => {
  it('refuses to move a category once an identity is reserved (D27)', async () => {
    const photo = await makePhoto(200)
    const { data: draftId } = await createDraft([photo.intakeFileId])

    await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: null,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 50_000,
      p_weight_g: 0,
      p_stock: 5,
      p_variant_kind: 'none',
      p_variants: [],
      p_images: [{ image_version_id: photo.generatedVersionId, position: 0 }],
      p_actor: ACTOR,
    })
    await db.rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: ACTOR })

    const { error } = await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: null,
      p_category_id: otherCategoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 50_000,
      p_weight_g: 0,
      p_stock: 5,
      p_variant_kind: 'none',
      p_variants: [],
      p_images: [{ image_version_id: photo.generatedVersionId, position: 0 }],
      p_actor: ACTOR,
    })
    expect(error?.code).toBe('22023')
    expect(error?.hint).toMatch(/Create a NEW draft/)

    // The suffix may still be corrected on the same frozen identity.
    const corrected = await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: null,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: '(Light Rose gold)',
      p_price_paise: 50_000,
      p_weight_g: 0,
      p_stock: 5,
      p_variant_kind: 'none',
      p_variants: [],
      p_images: [{ image_version_id: photo.generatedVersionId, position: 0 }],
      p_actor: ACTOR,
    })
    expect(corrected.error?.message).toBeUndefined()
  })

  it('refuses to publish a category with no confirmed Shopify tag (D23)', async () => {
    const photo = await makePhoto(300)
    const { data: draftId } = await createDraft([photo.intakeFileId], noseCategoryId)
    const before = await readCounter('NP')

    await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: null,
      p_category_id: noseCategoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 50_000,
      p_weight_g: 0,
      p_stock: 5,
      p_variant_kind: 'none',
      p_variants: [],
      p_images: [{ image_version_id: photo.generatedVersionId, position: 0 }],
      p_actor: ACTOR,
    })

    // Nose Pins has a confirmed tag since 2026-08-01, so this creates the
    // unconfirmed condition itself. D23's guard has to hold whether or not a
    // real category happens to be missing a tag today.
    const { data: saved } = await db
      .from('categories')
      .select('shopify_tag')
      .eq('id', noseCategoryId)
      .single<{ shopify_tag: string | null }>()
    await db.from('categories').update({ shopify_tag: null }).eq('id', noseCategoryId)
    try {
      const { error } = await db.rpc('reserve_draft_identity', {
        p_draft_id: draftId,
        p_actor: ACTOR,
      })
      expect(error?.message).toMatch(/no confirmed Shopify tag/)
      expect(await readCounter('NP')).toBe(before)
    } finally {
      await db
        .from('categories')
        .update({ shopify_tag: saved?.shopify_tag ?? 'NP' })
        .eq('id', noseCategoryId)
    }
  })

  it('marks the intake rows published with the draft, in one transaction', async () => {
    const photo = await makePhoto(400)
    const { data: draftId } = await createDraft([photo.intakeFileId])

    await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: null,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 50_000,
      p_weight_g: 0,
      p_stock: 5,
      p_variant_kind: 'colour',
      p_variants: [{ value: 'Gold', stock: 5 }],
      p_images: [{ image_version_id: photo.generatedVersionId, position: 0 }],
      p_actor: ACTOR,
    })
    await db.rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: ACTOR })

    const { data: usageBefore } = await db
      .from('colour_usage')
      .select('usage_count, colours ( name )')
      .eq('category_id', categoryId)

    const { error } = await db.rpc('mark_draft_published', {
      p_draft_id: draftId,
      p_shopify_product_id: `gid://shopify/Product/test-${RUN}`,
      p_actor: ACTOR,
    })
    expect(error?.message).toBeUndefined()

    const intake = await intakeRow(photo.intakeFileId)
    expect(intake.status).toBe('published')
    expect(await eventNames(photo.intakeFileId)).toContain('intake.published')

    // Colour usage is counted on publish, and only on the FIRST publish, so a
    // repair retry cannot inflate the per-category ranking.
    const goldBefore = (usageBefore ?? []).find((row) => {
      const embedded = (row as { colours?: unknown }).colours
      const one = Array.isArray(embedded) ? embedded[0] : embedded
      return (one as { name: string }).name === 'Gold'
    })
    await db.rpc('mark_draft_published', {
      p_draft_id: draftId,
      p_shopify_product_id: `gid://shopify/Product/test-${RUN}`,
      p_actor: ACTOR,
    })
    const { data: usageAfter } = await db
      .from('colour_usage')
      .select('usage_count, colours ( name )')
      .eq('category_id', categoryId)
    const goldAfter = (usageAfter ?? []).find((row) => {
      const embedded = (row as { colours?: unknown }).colours
      const one = Array.isArray(embedded) ? embedded[0] : embedded
      return (one as { name: string }).name === 'Gold'
    })
    const before = (goldBefore as { usage_count: number } | undefined)?.usage_count ?? 0
    expect((goldAfter as { usage_count: number }).usage_count).toBe(before + 1)
  })

  it('refuses to dismantle a published draft', async () => {
    const photo = await makePhoto(450)
    const { data: draftId } = await createDraft([photo.intakeFileId])

    await db.rpc('save_product_draft', {
      p_draft_id: draftId,
      p_expected_updated_at: null,
      p_category_id: categoryId,
      p_material_id: materialId,
      p_title_suffix: null,
      p_price_paise: 50_000,
      p_weight_g: 0,
      p_stock: 5,
      p_variant_kind: 'none',
      p_variants: [],
      p_images: [{ image_version_id: photo.generatedVersionId, position: 0 }],
      p_actor: ACTOR,
    })
    await db.rpc('reserve_draft_identity', { p_draft_id: draftId, p_actor: ACTOR })
    await db.rpc('mark_draft_published', {
      p_draft_id: draftId,
      p_shopify_product_id: `gid://shopify/Product/dismantle-${RUN}`,
      p_actor: ACTOR,
    })

    const { error } = await db.rpc('detach_intake_file', {
      p_draft_id: draftId,
      p_intake_file_id: photo.intakeFileId,
      p_actor: ACTOR,
    })
    expect(error?.code).toBe('55000')
    expect(error?.hint).toMatch(/Unpublish or delete the product in Shopify first/)

    // And the photograph is still recorded as published, not returned to the queue.
    expect((await intakeRow(photo.intakeFileId)).status).toBe('published')
  })
})

describe('Drive housekeeping is recorded, never a state transition', () => {
  it('records a failure without touching the published status', async () => {
    const photo = await makePhoto(500)
    const { data: draftId } = await createDraft([photo.intakeFileId])
    await db
      .from('intake_files')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', photo.intakeFileId)
    void draftId

    const { error } = await db.rpc('record_drive_housekeeping', {
      p_intake_file_id: photo.intakeFileId,
      p_ok: false,
      p_error: 'Drive said 403',
      p_actor: ACTOR,
    })
    expect(error?.message).toBeUndefined()

    const { data } = await db
      .from('intake_files')
      .select('status, published_at, drive_processed_at, drive_processed_error')
      .eq('id', photo.intakeFileId)
      .single<{
        status: string
        published_at: string | null
        drive_processed_at: string | null
        drive_processed_error: string | null
      }>()

    // Hard rule 3: the product stays published and the photograph is NOT walked
    // back to `enhanced`. Only the tidy-up is outstanding.
    expect(data!.status).toBe('published')
    expect(data!.published_at).not.toBeNull()
    expect(data!.drive_processed_at).toBeNull()
    expect(data!.drive_processed_error).toBe('Drive said 403')
    expect(await eventNames(photo.intakeFileId)).toContain('drive.processed_failed')
  })

  it('is idempotent — repeating a successful move changes nothing and clears the error', async () => {
    const photo = await makePhoto(600)
    await createDraft([photo.intakeFileId])
    await db.from('intake_files').update({ status: 'published' }).eq('id', photo.intakeFileId)

    await db.rpc('record_drive_housekeeping', {
      p_intake_file_id: photo.intakeFileId,
      p_ok: false,
      p_error: 'transient',
      p_actor: ACTOR,
    })
    await db.rpc('record_drive_housekeeping', {
      p_intake_file_id: photo.intakeFileId,
      p_ok: true,
      p_error: null,
      p_actor: ACTOR,
    })
    const first = await db
      .from('intake_files')
      .select('drive_processed_at, drive_processed_error')
      .eq('id', photo.intakeFileId)
      .single<{ drive_processed_at: string; drive_processed_error: string | null }>()

    await db.rpc('record_drive_housekeeping', {
      p_intake_file_id: photo.intakeFileId,
      p_ok: true,
      p_error: null,
      p_actor: ACTOR,
    })
    const second = await db
      .from('intake_files')
      .select('drive_processed_at, drive_processed_error')
      .eq('id', photo.intakeFileId)
      .single<{ drive_processed_at: string; drive_processed_error: string | null }>()

    expect(first.data!.drive_processed_error).toBeNull()
    // The first successful move is the one that is remembered.
    expect(second.data!.drive_processed_at).toBe(first.data!.drive_processed_at)
  })
})

/**
 * D60 supersedes D7: Save Draft creates a real Shopify product with status
 * DRAFT, so a SKU and handle must be reservable before a price exists.
 *
 * The danger in that change is not the draft path — it is that relaxing the
 * price guard could quietly relax it for PUBLISH too, which is hard rule 8 and
 * the single most expensive thing in this system to get wrong. These assert
 * both directions against the deployed function.
 */
describe('the Shopify draft stage (D60)', () => {
  let draftId: string

  beforeAll(async () => {
    const chosen = fixtures.slice(10, 11)
    const { data } = await createDraft(chosen.map((f) => f.intakeFileId))
    draftId = data as string
  })

  it('still REFUSES to reserve a priceless draft on the publish path', async () => {
    const { error } = await db.rpc('reserve_draft_identity', {
      p_draft_id: draftId,
      p_actor: ACTOR,
    })
    expect(error?.message ?? '').toMatch(/has no price/i)
  })

  it('reserves an identity for a priceless draft when publishing is not required', async () => {
    const { data, error } = await db
      .rpc('reserve_draft_identity', {
        p_draft_id: draftId,
        p_actor: ACTOR,
        p_require_publishable: false,
      })
      .select()
      .single<{ sku: string; handle: string }>()

    expect(error).toBeNull()
    expect(data!.sku).toMatch(/^NK[0-9]{3,}$/)
    expect(data!.handle.length).toBeGreaterThan(0)
  })

  it('records the Shopify id, leaves the draft editable, and never marks it published', async () => {
    const { error } = await db.rpc('record_draft_shopify_product', {
      p_draft_id: draftId,
      p_shopify_product_id: 'gid://shopify/Product/D60-TEST',
      p_actor: ACTOR,
    })
    expect(error).toBeNull()

    const { data } = await db
      .from('product_drafts')
      .select('status, shopify_product_id')
      .eq('id', draftId)
      .single<{ status: string; shopify_product_id: string }>()

    expect(data!.shopify_product_id).toBe('gid://shopify/Product/D60-TEST')
    // Reserving moves a draft to 'publishing'. Left there it is uneditable in
    // the console and Tracking calls it stalled after an hour.
    expect(data!.status).toBe('assembling')
  })

  it('replaces a deleted Shopify draft id without changing its reserved category SKU', async () => {
    const before = await db
      .from('product_drafts')
      .select('reserved_sku, reserved_handle')
      .eq('id', draftId)
      .single<{ reserved_sku: string; reserved_handle: string }>()

    const { error } = await db.rpc('record_draft_shopify_product', {
      p_draft_id: draftId,
      p_shopify_product_id: 'gid://shopify/Product/D60-RECREATED',
      p_actor: ACTOR,
    })
    expect(error).toBeNull()

    const after = await db
      .from('product_drafts')
      .select('reserved_sku, reserved_handle, shopify_product_id')
      .eq('id', draftId)
      .single<{
        reserved_sku: string
        reserved_handle: string
        shopify_product_id: string
      }>()
    expect(after.data).toEqual({
      reserved_sku: before.data!.reserved_sku,
      reserved_handle: before.data!.reserved_handle,
      shopify_product_id: 'gid://shopify/Product/D60-RECREATED',
    })
  })

  it('refuses an empty product id rather than recording a meaningless one', async () => {
    const { error } = await db.rpc('record_draft_shopify_product', {
      p_draft_id: draftId,
      p_shopify_product_id: '   ',
      p_actor: ACTOR,
    })
    expect(error?.code).toBe('22023')
  })
})
