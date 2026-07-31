import 'dotenv/config'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { makeThumbnail, readImageDimensions } from '@/lib/enhance/image'
import { R2ObjectStore } from '@/lib/enhance/storage'
import { serverEnv } from '@/lib/env'
import { perceptualHash, perceptualHashDistance } from '@/lib/duplicates/phash'
import { publishProduct } from '@/lib/publish/publish-product'
import { runShopifyReconciliation } from '@/lib/reconciliation/server'
import { ShopifyClient } from '@/lib/shopify/client'
import { deleteProduct } from '@/lib/shopify/product-set'
import { supabaseServer } from '@/lib/supabase/server'
import { loadTracking } from '@/lib/tracking/read-model'

const ACTOR = 'acceptance:phase6'
const ROOT = path.resolve('.artifacts/phase6-acceptance')
const FIXTURES = path.join(ROOT, 'fixtures.json')
const EVIDENCE = path.join(ROOT, 'evidence.json')
const SOURCE_PATH = path.resolve(
  '.artifacts/phase3c-acceptance/source/phase3b-01.png',
)
const GENERATED_PATH = path.resolve(
  '.artifacts/phase3c-acceptance/after/phase3b-01.png.png',
)

interface FixtureState {
  intakeFileIds: string[]
  draftId: string | null
  shopifyProductId: string | null
  objectKeys: string[]
  reconciliationRunIds: string[]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function store() {
  return new R2ObjectStore({
    endpoint: serverEnv.r2Endpoint,
    accessKeyId: serverEnv.r2AccessKeyId,
    secretAccessKey: serverEnv.r2SecretAccessKey,
    bucket: serverEnv.r2Bucket,
  })
}

async function saveState(state: FixtureState): Promise<void> {
  await mkdir(ROOT, { recursive: true })
  await writeFile(FIXTURES, `${JSON.stringify(state, null, 2)}\n`)
}

async function readState(): Promise<FixtureState> {
  return JSON.parse(await readFile(FIXTURES, 'utf8')) as FixtureState
}

async function createTrackedImage(
  input: Buffer,
  filename: string,
  discoveredAt: string,
): Promise<{ intakeId: string; objectKeys: string[]; phash: string }> {
  const db = supabaseServer()
  const objectStore = store()
  const intakeId = randomUUID()
  const storageKey = `versions/${intakeId}/v1.png`
  const thumbKey = `versions/${intakeId}/v1_thumb.webp`
  const png = await sharp(input).png().toBuffer()
  const thumb = await makeThumbnail(png)
  const dimensions = await readImageDimensions(png)
  const phash = await perceptualHash(input)
  await objectStore.putImmutable(storageKey, png, 'image/png', {
    'intake-id': intakeId,
    acceptance: 'phase6',
  })
  await objectStore.putImmutable(thumbKey, thumb, 'image/webp', {
    'intake-id': intakeId,
    acceptance: 'phase6',
  })
  const { error: intakeError } = await db.from('intake_files').insert({
    id: intakeId,
    drive_file_id: `phase6-${intakeId}`,
    filename,
    bytes: input.byteLength,
    mime_type: 'image/png',
    status: 'enhanced',
    attempts: 1,
    phash,
    discovered_at: discoveredAt,
    enhanced_at: discoveredAt,
    updated_at: discoveredAt,
    product_description: 'Phase 6 duplicate acceptance photograph.',
    presentation_class: 'flat-curve',
    presentation_fallback: false,
    description_model: 'acceptance:phase6',
    described_at: discoveredAt,
    description_cost_usd: 0,
  })
  if (intakeError) throw new Error(intakeError.message)
  const { error: versionError } = await db.from('image_versions').insert({
    intake_file_id: intakeId,
    version_no: 1,
    kind: 'generated',
    storage_key: storageKey,
    thumb_key: thumbKey,
    width: dimensions.width,
    height: dimensions.height,
    prompt_text: 'Phase 6 acceptance fixture — no paid generation.',
    model: 'acceptance:fixture',
    cost_usd: 0,
    is_selected: true,
    description_injected: true,
    description_missing: false,
  })
  if (versionError) throw new Error(versionError.message)
  return { intakeId, objectKeys: [storageKey, thumbKey], phash }
}

async function createRetryableFailure(): Promise<string> {
  const id = randomUUID()
  const { error } = await supabaseServer().from('intake_files').insert({
    id,
    drive_file_id: `phase6-${id}`,
    filename: 'phase6-retryable.jpg',
    bytes: 123,
    mime_type: 'image/jpeg',
    status: 'failed',
    attempts: 5,
    last_error: 'The image provider was unavailable after five bounded attempts.',
    last_error_code: 'provider_unavailable',
    last_error_detail: '{"provider":"acceptance fixture","authorization":"[redacted]"}',
    error_class: 'retryable',
  })
  if (error) throw new Error(error.message)
  return id
}

async function createPublishedFixture(
  image: Buffer,
): Promise<{
  draftId: string
  intakeId: string
  objectKeys: string[]
  shopifyProductId: string
  sku: string
}> {
  const db = supabaseServer()
  const objectStore = store()
  const [{ data: category, error: categoryError }, { data: material, error: materialError }] =
    await Promise.all([
      db
        .from('categories')
        .select('id')
        .eq('sku_prefix', 'NK')
        .single<{ id: string }>(),
      db.from('materials').select('id').eq('name', '316L').single<{ id: string }>(),
    ])
  if (categoryError || !category) throw new Error(categoryError?.message || 'No NK category.')
  if (materialError || !material) throw new Error(materialError?.message || 'No 316L material.')

  const { data: draft, error: draftError } = await db
    .from('product_drafts')
    .insert({
      category_id: category.id,
      material_id: material.id,
      price_paise: 12345,
      weight_g: 0,
      stock: 1,
      status: 'assembling',
      created_by: ACTOR,
    })
    .select('id')
    .single<{ id: string }>()
  if (draftError || !draft) throw new Error(draftError?.message || 'Could not create draft.')

  const intakeId = randomUUID()
  const png = await sharp(image).png().toBuffer()
  const dimensions = await readImageDimensions(png)
  const thumb = await makeThumbnail(png)
  const storageKey = `versions/${intakeId}/v1.png`
  const thumbKey = `versions/${intakeId}/v1_thumb.webp`
  await objectStore.putImmutable(storageKey, png, 'image/png', {
    'intake-id': intakeId,
    acceptance: 'phase6',
  })
  await objectStore.putImmutable(thumbKey, thumb, 'image/webp', {
    'intake-id': intakeId,
    acceptance: 'phase6',
  })

  const { error: intakeError } = await db.from('intake_files').insert({
    id: intakeId,
    drive_file_id: `phase6-${intakeId}`,
    filename: 'phase6-reconciliation.png',
    bytes: png.byteLength,
    mime_type: 'image/png',
    status: 'grouped',
    attempts: 1,
    phash: await perceptualHash(png),
    enhanced_at: new Date().toISOString(),
    grouped_at: new Date().toISOString(),
    product_draft_id: draft.id,
    product_description:
      'A necklace acceptance photograph used to prove Phase 6 Shopify reconciliation.',
    presentation_class: 'flat-curve',
    presentation_fallback: false,
    description_model: 'acceptance:phase6',
    described_at: new Date().toISOString(),
    description_cost_usd: 0,
  })
  if (intakeError) throw new Error(intakeError.message)
  const { data: version, error: versionError } = await db
    .from('image_versions')
    .insert({
      intake_file_id: intakeId,
      version_no: 1,
      kind: 'generated',
      storage_key: storageKey,
      thumb_key: thumbKey,
      width: dimensions.width,
      height: dimensions.height,
      prompt_text: 'Phase 6 reconciliation acceptance fixture.',
      model: 'acceptance:fixture',
      cost_usd: 0,
      is_selected: true,
      description_injected: true,
      description_missing: false,
    })
    .select('id')
    .single<{ id: string }>()
  if (versionError || !version) throw new Error(versionError?.message || 'No image version.')
  const { error: linkError } = await db.from('product_draft_images').insert({
    product_draft_id: draft.id,
    image_version_id: version.id,
    position: 0,
  })
  if (linkError) throw new Error(linkError.message)

  const published = await publishProduct(db, new ShopifyClient(), draft.id, {
    actor: ACTOR,
    extraTags: ['LOUPE_PHASE6_ACCEPTANCE'],
    signImageUrl: (key) => objectStore.presignGet(key, 15 * 60),
  })
  return {
    draftId: draft.id,
    intakeId,
    objectKeys: [storageKey, thumbKey],
    shopifyProductId: published.shopifyProductId,
    sku: published.sku,
  }
}

async function accept(): Promise<void> {
  await mkdir(ROOT, { recursive: true })
  try {
    await readFile(FIXTURES)
    throw new Error('Phase 6 fixtures already exist. Run cleanup first.')
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }

  const state: FixtureState = {
    intakeFileIds: [],
    draftId: null,
    shopifyProductId: null,
    objectKeys: [],
    reconciliationRunIds: [],
  }
  await saveState(state)

  const source = await readFile(SOURCE_PATH)
  const generated = await readFile(GENERATED_PATH)
  const older = await createTrackedImage(
    source,
    'phase6-stale.png',
    new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  )
  const recompressed = await sharp(source).resize(900, 900, { fit: 'inside' }).jpeg({ quality: 74 }).toBuffer()
  const newer = await createTrackedImage(
    recompressed,
    'phase6-duplicate-copy.jpg',
    new Date().toISOString(),
  )
  const retryableId = await createRetryableFailure()
  state.intakeFileIds.push(older.intakeId, newer.intakeId, retryableId)
  state.objectKeys.push(...older.objectKeys, ...newer.objectKeys)
  await saveState(state)

  const distance = perceptualHashDistance(older.phash, newer.phash)
  assert(distance <= 8, `Acceptance duplicate distance ${distance} exceeded 8.`)
  const trackingBeforePublish = await loadTracking()
  const staleRow = trackingBeforePublish.rows.find(
    (row) => row.entityId === older.intakeId,
  )
  const duplicateRow = trackingBeforePublish.rows.find(
    (row) => row.entityId === newer.intakeId,
  )
  const retryRow = trackingBeforePublish.rows.find(
    (row) => row.entityId === retryableId,
  )
  assert(staleRow?.statusLabel === 'Stalled', '25-hour fixture was not stalled.')
  assert(duplicateRow?.statusLabel === 'Possible duplicate', 'Near copy was not warned.')
  assert(duplicateRow.duplicate?.distance === distance, 'Tracking stored the wrong distance.')
  assert(retryRow?.canRetry === true, 'Retryable failure did not offer Retry.')

  const published = await createPublishedFixture(generated)
  state.draftId = published.draftId
  state.shopifyProductId = published.shopifyProductId
  state.intakeFileIds.push(published.intakeId)
  state.objectKeys.push(...published.objectKeys)
  await saveState(state)

  const clean = await runShopifyReconciliation(ACTOR)
  state.reconciliationRunIds.push(clean.runId)
  assert(clean.totalProducts >= 1, 'Clean reconciliation read no published products.')
  assert(clean.issueCount === 0, `Clean reconciliation reported ${clean.issueCount} issues.`)

  const { error: mismatchError } = await supabaseServer()
    .from('product_drafts')
    .update({ title_suffix: '(mismatch probe)' })
    .eq('id', published.draftId)
  if (mismatchError) throw new Error(mismatchError.message)
  const mismatch = await runShopifyReconciliation(ACTOR)
  state.reconciliationRunIds.push(mismatch.runId)
  assert(mismatch.issueCount >= 1, 'Deliberate title mismatch was not recorded.')

  const { error: restoreError } = await supabaseServer()
    .from('product_drafts')
    .update({ title_suffix: null })
    .eq('id', published.draftId)
  if (restoreError) throw new Error(restoreError.message)
  const restored = await runShopifyReconciliation(ACTOR)
  state.reconciliationRunIds.push(restored.runId)
  assert(restored.issueCount === 0, 'Restored product did not reconcile cleanly.')
  await saveState(state)

  const evidence = {
    generatedAt: new Date().toISOString(),
    duplicate: {
      intakeFileId: newer.intakeId,
      matchIntakeFileId: older.intakeId,
      distance,
      warningOnly: true,
    },
    ageBoundary: {
      intakeFileId: older.intakeId,
      ageHours: 25,
      statusLabel: staleRow.statusLabel,
    },
    retryable: {
      intakeFileId: retryableId,
      canRetry: retryRow.canRetry,
    },
    reconciliation: {
      productDraftId: published.draftId,
      shopifyProductId: published.shopifyProductId,
      sku: published.sku,
      clean,
      mismatch,
      restored,
    },
  }
  await writeFile(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log('Phase 6 live acceptance PASS')
  console.log(JSON.stringify(evidence, null, 2))
  console.log('Fixtures left for browser review. Run cleanup afterwards.')
}

async function cleanup(): Promise<void> {
  const state = await readState()
  const db = supabaseServer()
  if (state.shopifyProductId) {
    try {
      await deleteProduct(new ShopifyClient(), state.shopifyProductId)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Product does not exist')) {
        throw error
      }
    }
  }
  if (state.reconciliationRunIds.length > 0) {
    const { error } = await db
      .from('shopify_reconciliation_runs')
      .delete()
      .in('id', state.reconciliationRunIds)
    if (error) throw new Error(error.message)
  }
  const { error: actorRunsError } = await db
    .from('shopify_reconciliation_runs')
    .delete()
    .eq('started_by', ACTOR)
  if (actorRunsError) throw new Error(actorRunsError.message)
  if (state.draftId) {
    const { error } = await db
      .from('product_draft_images')
      .delete()
      .eq('product_draft_id', state.draftId)
    if (error) throw new Error(error.message)
  }
  if (state.intakeFileIds.length > 0) {
    const { error } = await db.from('intake_files').delete().in('id', state.intakeFileIds)
    if (error) throw new Error(error.message)
    await db.from('events').delete().in('entity_id', state.intakeFileIds)
  }
  if (state.draftId) {
    const { error } = await db.from('product_drafts').delete().eq('id', state.draftId)
    if (error) throw new Error(error.message)
  }
  await db.from('events').delete().eq('actor', ACTOR)
  const objectStore = store()
  for (const key of state.objectKeys) await objectStore.delete(key)
  await writeFile(
    path.join(ROOT, 'cleanup.json'),
    `${JSON.stringify({ cleanedAt: new Date().toISOString(), ...state }, null, 2)}\n`,
  )
  await unlink(FIXTURES)
  console.log('Phase 6 acceptance cleanup PASS')
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'accept') await accept()
  else if (mode === 'cleanup') await cleanup()
  else throw new Error('Usage: npm run verify:phase6 -- accept|cleanup')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
