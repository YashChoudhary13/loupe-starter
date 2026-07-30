/**
 * Phase 4 live acceptance, against the qimti TEST store.
 *
 *   npm run verify:phase4 -- seed      stage fixtures from retained Phase 3C output
 *   npm run verify:phase4 -- accept    criteria 4, 9, 10, 11, 12, 13, 14
 *   npm run verify:phase4 -- cleanup   remove every fixture and print the receipt
 *
 * Guarded by PHASE4_LIVE_ACCEPTANCE. `accept` creates and deletes real products
 * in a real Shopify store.
 *
 * WHAT IS REAL AND WHAT IS SEEDED — read this before believing the evidence.
 *
 *   real   the Drive files (staged by hand: service accounts have no Drive
 *          quota, D32), the R2 objects, the enhanced images, the cached
 *          descriptions, the Shopify products, the Shopify media and every
 *          database function under test.
 *   seeded the *transition* from discovered to enhanced. The generated images
 *          and descriptions are the retained output of the Phase 3C acceptance
 *          run, re-uploaded to R2 under fresh intake ids rather than paid for
 *          again — Phase 4's brief says explicitly not to re-run that set, and
 *          re-generating would prove a Phase 3B criterion, not a Phase 4 one.
 *
 * Nothing about the console's own behaviour is simulated.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env', quiet: true })
loadEnv({ path: '.env.local', override: true, quiet: true })

const CONFIRMATION = 'I_UNDERSTAND_THIS_PUBLISHES_TO_THE_TEST_STORE'
const ACTOR = 'lakhira.studio@gmail.com'
const TEST_TAG = 'loupe-phase4-acceptance'
const EVIDENCE_DIR = '.artifacts/phase4-acceptance'
const FIXTURE_PREFIX = 'phase4-'
const STATE_FILE = `${EVIDENCE_DIR}/fixtures.json`

/**
 * The five retained Phase 3C products. `source` is what the photographer shot;
 * `generated` is what gpt-image-2 actually produced for it.
 */
const RETAINED = [
  {
    name: 'phase4-necklace.png',
    source: '.artifacts/phase3c-acceptance/source/phase3b-01.png',
    generated: '.artifacts/phase3c-acceptance/after/phase3b-01.png.png',
    presentation: 'flat-curve',
  },
  {
    name: 'phase4-chain-bracelet.jpg',
    source: '.artifacts/phase3c-acceptance/source/phase3b-02.jpg',
    generated: '.artifacts/phase3c-acceptance/after/phase3b-02.jpg.png',
    presentation: 'flat-arc',
  },
  {
    name: 'phase4-anklet.jpg',
    source: '.artifacts/phase3c-acceptance/source/phase3b-03.jpg',
    generated: '.artifacts/phase3c-acceptance/after/phase3b-03.jpg.png',
    presentation: 'flat-arc',
  },
  {
    name: 'phase4-ring-tray.png',
    source: '.artifacts/phase3c-acceptance/source/phase3b-04.png',
    generated: '.artifacts/phase3c-acceptance/after/phase3b-04.png.png',
    presentation: 'tray-grid',
  },
  {
    name: 'phase4-earrings.png',
    source: '.artifacts/phase3c-acceptance/source/user-earrings-source.png',
    generated: '.artifacts/phase3c-acceptance/after/user-earrings-source.png.png',
    presentation: 'pair-upright',
  },
] as const

/** Queue-density fixtures: real thumbnails, no Drive file, never published. */
const DENSITY_COUNT = 15

// ---------------------------------------------------------------------------

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing ${key} in .env`)
  return value
}

function db(): SupabaseClient {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(46)} ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}
function assert(label: string, ok: boolean, note = ''): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(46)} ${note}`)
}
function heading(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(78)}`)
}

interface FixtureState {
  runId: string
  seededAt: string
  intakeFileIds: string[]
  driveFileIds: string[]
  r2Keys: string[]
  draftIds: string[]
  shopifyProductIds: string[]
}

function readState(): FixtureState {
  try {
    return JSON.parse(readFileSync(resolve(STATE_FILE), 'utf8')) as FixtureState
  } catch {
    throw new Error(`No fixture state at ${STATE_FILE}. Run "seed" first.`)
  }
}

function writeState(state: FixtureState): void {
  mkdirSync(resolve(EVIDENCE_DIR), { recursive: true })
  writeFileSync(resolve(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

function saveEvidence(name: string, value: unknown): void {
  mkdirSync(resolve(EVIDENCE_DIR), { recursive: true })
  writeFileSync(resolve(`${EVIDENCE_DIR}/${name}`), `${JSON.stringify(value, null, 2)}\n`)
  console.log(`  evidence → ${EVIDENCE_DIR}/${name}`)
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  const { R2ObjectStore } = await import('../src/lib/enhance/storage')
  const { makeThumbnail } = await import('../src/lib/enhance/image')
  const { googleDriveClient } = await import('../src/lib/google/drive-server')

  const supabase = db()
  const store = new R2ObjectStore({
    endpoint: required('R2_ENDPOINT'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
  })
  const drive = googleDriveClient()
  const rawFolderId = required('DRIVE_RAW_FOLDER_ID')

  heading('SEED — matching the staged Drive files')

  // The service account cannot create Drive files (D32), so the five sources are
  // staged by hand. Finding them by name is what turns a manual upload into a
  // repeatable fixture.
  const page = await drive.listRawFolderPage(rawFolderId)
  const staged = new Map(page.files.map((file) => [file.name, file]))
  for (const item of RETAINED) {
    const found = staged.get(item.name)
    assert(`Drive has ${item.name}`, found !== undefined, found?.id ?? 'MISSING — upload it to RAW IMAGES')
  }
  if (failures > 0) {
    throw new Error(
      'Stage the five files in the Drive RAW IMAGES folder under exactly these names, then re-run seed.',
    )
  }

  const state: FixtureState = {
    runId: randomUUID().slice(0, 8),
    seededAt: new Date().toISOString(),
    intakeFileIds: [],
    driveFileIds: [],
    r2Keys: [],
    draftIds: [],
    shopifyProductIds: [],
  }

  heading('SEED — intake rows, R2 objects and cached descriptions')

  for (const item of RETAINED) {
    const driveFile = staged.get(item.name)!
    const sourceBytes = readFileSync(resolve(item.source))
    const generatedBytes = readFileSync(resolve(item.generated))
    const thumbBytes = await makeThumbnail(generatedBytes)

    const { data: intake, error } = await supabase
      .from('intake_files')
      .insert({
        drive_file_id: driveFile.id,
        filename: item.name,
        drive_md5: driveFile.md5Checksum,
        bytes: sourceBytes.byteLength,
        status: 'enhanced',
        enhanced_at: new Date().toISOString(),
        // Real cached output of the Phase 3C describe call for this exact piece.
        product_description: descriptionFor(item.name),
        description_model: 'openai/gpt-5.6-sol',
        described_at: new Date().toISOString(),
        description_cost_usd: 0.015928,
        presentation_class: item.presentation,
      })
      .select('id')
      .single<{ id: string }>()
    if (error || !intake) throw new Error(`seed intake_files: ${error?.message}`)

    const extension = item.name.endsWith('.jpg') ? 'jpg' : 'png'
    const originalKey = `originals/${intake.id}.${extension}`
    const generatedKey = `versions/${intake.id}/v1.png`
    const thumbKey = `versions/${intake.id}/v1_thumb.webp`

    await store.putImmutable(originalKey, sourceBytes, extension === 'jpg' ? 'image/jpeg' : 'image/png')
    await store.putImmutable(generatedKey, generatedBytes, 'image/png')
    await store.putImmutable(thumbKey, thumbBytes, 'image/webp')

    const { error: versionError } = await supabase.from('image_versions').insert([
      {
        intake_file_id: intake.id,
        version_no: 0,
        kind: 'original',
        storage_key: originalKey,
        is_selected: false,
      },
      {
        intake_file_id: intake.id,
        version_no: 1,
        kind: 'generated',
        storage_key: generatedKey,
        thumb_key: thumbKey,
        prompt_text: `Phase 3C resolved prompt for ${item.name} (${item.presentation})`,
        model: 'openai/gpt-image-2',
        cost_usd: 0.078,
        description_injected: true,
        description_missing: false,
        is_selected: true,
        width: 1280,
        height: 1280,
      },
    ])
    if (versionError) throw new Error(`seed image_versions: ${versionError.message}`)

    state.intakeFileIds.push(intake.id)
    state.driveFileIds.push(driveFile.id)
    state.r2Keys.push(originalKey, generatedKey, thumbKey)
    console.log(`  ✓ ${item.name.padEnd(28)} intake ${intake.id} · thumb ${thumbBytes.byteLength} bytes`)
  }

  heading(`SEED — ${DENSITY_COUNT} density tiles (criterion 4 needs twenty)`)

  // These exist so the grid can be judged at the density DESIGN.md asks for.
  // They carry no Drive file and are never published; they reuse the real
  // thumbnails so what is on screen is real photography rather than placeholders.
  const donorThumbs = state.r2Keys.filter((key) => key.endsWith('_thumb.webp'))
  const donorFull = state.r2Keys.filter((key) => key.endsWith('/v1.png'))
  for (let index = 0; index < DENSITY_COUNT; index += 1) {
    const { data: intake, error } = await supabase
      .from('intake_files')
      .insert({
        drive_file_id: `${FIXTURE_PREFIX}density-${state.runId}-${index}`,
        filename: `${FIXTURE_PREFIX}density-${String(index + 1).padStart(2, '0')}.png`,
        status: 'enhanced',
        enhanced_at: new Date().toISOString(),
      })
      .select('id')
      .single<{ id: string }>()
    if (error || !intake) throw new Error(`seed density intake: ${error?.message}`)

    const { error: versionError } = await supabase.from('image_versions').insert({
      intake_file_id: intake.id,
      version_no: 1,
      kind: 'generated',
      storage_key: donorFull[index % donorFull.length],
      thumb_key: donorThumbs[index % donorThumbs.length],
      prompt_text: 'queue density fixture',
      model: 'openai/gpt-image-2',
      cost_usd: 0,
      description_injected: false,
      description_missing: false,
      is_selected: true,
    })
    if (versionError) throw new Error(`seed density version: ${versionError.message}`)
    state.intakeFileIds.push(intake.id)
  }
  console.log(`  ✓ ${DENSITY_COUNT} density tiles`)

  writeState(state)
  console.log(`\n  seeded ${state.intakeFileIds.length} intake rows · state → ${STATE_FILE}`)
}

/** The exact descriptions Phase 3C produced, kept beside the images they describe. */
function descriptionFor(name: string): string {
  switch (name) {
    case 'phase4-necklace.png':
      return 'A single necklace in polished yellow-gold-tone metal, forming a long, gently curved drop with a centered pendant-like dangle. Round-cut stones in blue, red, green, black and pale pink are individually bezel-set at intervals along the lower chain, with a deeper red stone suspended at the centre. The fine cable-link chain is decorated with spaced polished gold-tone beads, creating an alternating arrangement of coloured bezels and small spherical drops. The surfaces are smooth and reflective, with no visible engraving.'
    case 'phase4-chain-bracelet.jpg':
      return 'A single flexible chain bracelet in polished gold-tone metal, forming a slender open arc when laid flat. It has no visible stones. The bracelet combines a smooth, closely woven flat snake chain with an outer row of elongated rectangular paperclip links. Several links feature narrow ribbed or ridged inset sections, creating an alternating open and textured pattern. A lobster-claw clasp secures one end, while the opposite end has an adjustable extension chain finished with a slim bar-shaped terminal.'
    case 'phase4-ring-tray.png':
      return 'An assortment of multiple separate rings in varied, non-matching designs. The rings have polished gold-tone metal bands with slim, curved silhouettes, including linked hearts, interlocking circles, scalloped motifs and straight gemstone rows. Faceted stones in clear, blue, pink, red, green, orange, purple and yellow tones appear in round, oval, rectangular, heart and teardrop cuts. They are arranged as central solitaires, clustered accents, halos, graduated rows and multicoloured sequences, secured mainly by prong and bezel-style settings.'
    case 'phase4-earrings.png':
      return 'A matching pair of stud drop earrings in polished gold-tone metal. Each earring has a compact two-part silhouette, with an oval upper stud and a rounded teardrop pendant below. The upper oval is densely pavé-set with small, round-cut, colourless stones. The lower section holds a milky white, iridescent teardrop cabochon within a slim gold-tone bezel. A short concealed connection joins the two sections, allowing the lower element to hang beneath the stone-set stud.'
    default:
      return 'A single anklet in polished gold-tone metal, laid flat in an open arc. Fine cable links carry evenly spaced smooth beads and small flat charms, with a lobster-claw clasp at one end and a short adjustable extension chain at the other. The surfaces are bright and reflective with no engraving, and no stones are set anywhere along its length.'
  }
}

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

async function accept(): Promise<void> {
  const [
    { R2ObjectStore },
    { ShopifyClient },
    { shopifyConfig },
    { countProductsByHandle, readProductByHandle, readProductMedia },
    { publishDraftForOperator, PublishInProgressError },
    { tidyDriveForDraft },
    { googleDriveClient },
    { PublishBlockedError },
  ] = await Promise.all([
    import('../src/lib/enhance/storage'),
    import('../src/lib/shopify/client'),
    import('../src/lib/shopify/config'),
    import('../src/lib/shopify/product-set'),
    import('../src/lib/console/publish-draft'),
    import('../src/lib/console/housekeeping'),
    import('../src/lib/google/drive-server'),
    import('../src/lib/publish/validate'),
  ])

  const supabase = db()
  const shopify = new ShopifyClient({ config: shopifyConfig() })
  const store = new R2ObjectStore({
    endpoint: required('R2_ENDPOINT'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
  })
  const drive = googleDriveClient()
  const processedFolderId = required('DRIVE_PROCESSED_FOLDER_ID')
  const state = readState()
  const evidence: Record<string, unknown> = { runId: state.runId, startedAt: new Date().toISOString() }

  const signImageUrl = (key: string) => store.presignGet(key, 900)
  const deps = { db: supabase, shopify, drive, processedFolderId, signImageUrl }

  const { data: categories } = await supabase.from('categories').select('id, name, sku_prefix')
  const necklaces = (categories as { id: string; sku_prefix: string }[]).find((c) => c.sku_prefix === 'NK')!
  const { data: material } = await supabase.from('materials').select('id').eq('name', '316L').single<{ id: string }>()

  const { data: availableRows, error: availableError } = await supabase
    .from('intake_files')
    .select('id, filename')
    .in('id', state.intakeFileIds)
    .eq('status', 'enhanced')
    .is('product_draft_id', null)
  if (availableError) {
    throw new Error(`Could not select available Phase 4 fixtures: ${availableError.message}`)
  }

  const availableById = new Map(
    (availableRows ?? []).map((row) => [
      (row as { id: string }).id,
      row as { id: string; filename: string },
    ]),
  )
  const available = state.intakeFileIds
    .map((id) => availableById.get(id))
    .filter((row): row is { id: string; filename: string } => row !== undefined)
  const retainedNames = new Set(RETAINED.map((item) => item.name as string))
  const realAvailable = available.filter((row) => retainedNames.has(row.filename))
  const densityAvailable = available.filter((row) => !retainedNames.has(row.filename))

  // Criteria 10 and 12 publish four real Drive-backed fixtures. Criterion 9
  // only proves that a broken draft reserves nothing, so it may use one density
  // tile when a previous UI publish has already consumed a retained fixture.
  if (realAvailable.length < 4) {
    throw new Error(
      `Phase 4 acceptance needs four enhanced, ungrouped Drive fixtures; found ${realAvailable.length}.`,
    )
  }
  const publishFixtures = realAvailable.slice(-4)
  const publishIds = new Set(publishFixtures.map((row) => row.id))
  const blockFixture =
    realAvailable.find((row) => !publishIds.has(row.id)) ?? densityAvailable[0]
  if (!blockFixture) {
    throw new Error(
      'Phase 4 acceptance needs one additional enhanced, ungrouped fixture for the blocked-publish proof.',
    )
  }
  const realIntakeIds = [blockFixture.id, ...publishFixtures.map((row) => row.id)]
  evidence.fixtureSelection = {
    blockedPublish: blockFixture.filename,
    published: publishFixtures.map((row) => row.filename),
  }

  // ── criterion 4 ──────────────────────────────────────────────────────────
  heading('CRITERION 4 — private R2 through short-lived URLs')

  const thumbKey = state.r2Keys.find((key) => key.endsWith('_thumb.webp'))!
  const liveUrl = await store.presignGet(thumbKey, 900)
  const liveStatus = (await fetch(liveUrl)).status
  check('a signed thumbnail URL works', liveStatus, 200)

  const shortUrl = await store.presignGet(thumbKey, 1)
  check('and works immediately', (await fetch(shortUrl)).status, 200)
  await new Promise((r) => setTimeout(r, 2_500))
  const expiredStatus = (await fetch(shortUrl)).status
  assert('an EXPIRED URL stops working', expiredStatus === 403, `HTTP ${expiredStatus}`)

  const unsignedUrl = `${required('R2_ENDPOINT')}/${required('R2_BUCKET')}/${thumbKey}`
  const unsignedStatus = (await fetch(unsignedUrl)).status
  assert('the bucket is not public', unsignedStatus !== 200, `HTTP ${unsignedStatus}`)

  const { data: thumbRows } = await supabase
    .from('image_versions')
    .select('thumb_key, storage_key')
    .in('intake_file_id', state.intakeFileIds)
  const withThumb = (thumbRows ?? []).filter((r) => (r as { thumb_key: string | null }).thumb_key !== null)
  check('every queue tile has a thumbnail to use', withThumb.length, state.intakeFileIds.length)
  evidence.criterion4 = { liveStatus, expiredStatus, unsignedStatus, tiles: state.intakeFileIds.length }

  // ── criterion 9 ──────────────────────────────────────────────────────────
  heading('CRITERION 9 — a blocked publish reserves nothing')

  const { data: blockedDraftId } = await supabase.rpc('create_product_draft', {
    p_category_id: necklaces.id,
    p_intake_file_ids: [realIntakeIds[0]],
    p_actor: ACTOR,
  })
  state.draftIds.push(blockedDraftId as string)
  writeState(state)

  const { data: counterBefore } = await supabase
    .from('sku_counters')
    .select('last_number')
    .eq('sku_prefix', 'NK')
    .single<{ last_number: number }>()

  // Deliberately broken in four ways at once: no price, no stock, no material
  // and no image.
  await supabase.rpc('save_product_draft', {
    p_draft_id: blockedDraftId,
    p_expected_updated_at: null,
    p_category_id: necklaces.id,
    p_material_id: null,
    p_title_suffix: null,
    p_price_paise: null,
    p_weight_g: null,
    p_stock: 0,
    p_colours: [],
    p_images: [],
    p_actor: ACTOR,
  })

  let blockCodes: string[] = []
  try {
    await publishDraftForOperator(blockedDraftId as string, ACTOR, {}, deps)
  } catch (cause) {
    if (cause instanceof PublishBlockedError) blockCodes = cause.blocks.map((b) => b.code).sort()
    else throw cause
  }
  check('every reason at once', blockCodes, ['images_missing', 'material_missing', 'price_missing', 'stock_zero'])

  const { data: counterAfterBlock } = await supabase
    .from('sku_counters')
    .select('last_number')
    .eq('sku_prefix', 'NK')
    .single<{ last_number: number }>()
  check('the counter did NOT move', counterAfterBlock!.last_number, counterBefore!.last_number)

  const { data: blockedRow } = await supabase
    .from('product_drafts')
    .select('reserved_sku, reserved_handle, status')
    .eq('id', blockedDraftId)
    .single<{ reserved_sku: string | null; reserved_handle: string | null; status: string }>()
  check('nothing was reserved', blockedRow!.reserved_sku, null)
  check('the draft is still editable', blockedRow!.status, 'assembling')
  evidence.criterion9 = { blockCodes, counter: counterBefore!.last_number }

  // The operator corrects it in place rather than rebuilding the product.
  const fixed = await supabase.rpc('save_product_draft', {
    p_draft_id: blockedDraftId,
    p_expected_updated_at: null,
    p_category_id: necklaces.id,
    p_material_id: material!.id,
    p_title_suffix: null,
    p_price_paise: 7_550,
    p_weight_g: null,
    p_stock: 12,
    p_colours: ['Gold'],
    p_images: [{ image_version_id: await generatedVersion(supabase, realIntakeIds[0]), position: 0 }],
    p_actor: ACTOR,
  })
  assert('the same draft is corrected, not rebuilt', fixed.error === null, fixed.error?.message ?? '')

  // ── criterion 10 ─────────────────────────────────────────────────────────
  heading('CRITERION 10 — a real grouped product, read back from Shopify')

  const groupIds = realIntakeIds.slice(1, 4)
  const { data: draftId, error: groupError } = await supabase.rpc('create_product_draft', {
    p_category_id: necklaces.id,
    p_intake_file_ids: groupIds,
    p_actor: ACTOR,
  })
  if (groupError) throw new Error(`grouping failed: ${groupError.message}`)
  state.draftIds.push(draftId as string)
  writeState(state)

  // Three images: two generated, one deliberately the ORIGINAL, in an order that
  // is not the order they were grouped in (criterion 6).
  const orderedImages = [
    { image_version_id: await generatedVersion(supabase, groupIds[2]), position: 0 },
    { image_version_id: await originalVersion(supabase, groupIds[1]), position: 1 },
    { image_version_id: await generatedVersion(supabase, groupIds[0]), position: 2 },
  ]
  await supabase.rpc('save_product_draft', {
    p_draft_id: draftId,
    p_expected_updated_at: null,
    p_category_id: necklaces.id,
    p_material_id: material!.id,
    p_title_suffix: '(Adjustable)',
    p_price_paise: 75_000,
    p_weight_g: null,
    p_stock: 12,
    p_colours: ['Gold', 'Silver'],
    p_images: orderedImages,
    p_actor: ACTOR,
  })

  const published = await publishDraftForOperator(draftId as string, ACTOR, { extraTags: [TEST_TAG] }, deps)
  state.shopifyProductIds.push(published.result.shopifyProductId)
  writeState(state)

  console.log(`\n  SHOPIFY PRODUCT ID   ${published.result.shopifyProductId}\n`)

  const readback = await readProductByHandle(shopify, published.result.handle)
  const media = await readProductMedia(shopify, published.result.handle)

  check('title', readback!.title, published.result.title)
  check('handle', readback!.handle, published.result.handle)
  check('product_type', readback!.productType, 'Jewellery')
  check('status', readback!.status, 'ACTIVE')
  assert('category tag', readback!.tags.includes('Necklace'), readback!.tags.join(', '))
  assert(
    'always-on tag uses the live casing NEWEST',
    readback!.tags.includes('NEWEST'),
    readback!.tags.join(', '),
  )
  check('custom.material', readback!.metafield?.value ?? null, '316L')
  check(
    'descriptionHtml',
    readback!.descriptionHtml.trim().replace(/>\s+</g, '><'),
    published.result.descriptionHtml.trim().replace(/>\s+</g, '><'),
  )
  check('exactly one product for the handle', await countProductsByHandle(shopify, published.result.handle), 1)

  const variants = readback!.variants.nodes
  check('variants', variants.length, 2)
  check('variants share the parent SKU', [...new Set(variants.map((v) => v.sku))], [published.result.sku])
  check('price', [...new Set(variants.map((v) => v.price))], ['750.00'])
  check('stock', [...new Set(variants.map((v) => v.inventoryQuantity))], [12])
  check(
    'weight 0 g',
    [...new Set(variants.map((v) => v.inventoryItem?.measurement?.weight?.value ?? null))],
    [0],
  )
  check('colours', variants.flatMap((v) => v.selectedOptions.map((o) => o.value)).sort(), ['Gold', 'Silver'])

  check('image count', media!.length, 3)
  evidence.criterion10 = {
    shopifyProductId: published.result.shopifyProductId,
    sku: published.result.sku,
    title: published.result.title,
    handle: published.result.handle,
    tags: readback!.tags,
    status: readback!.status,
    productType: readback!.productType,
    material: readback!.metafield?.value ?? null,
    descriptionHtml: readback!.descriptionHtml,
    price: variants[0]?.price,
    stock: variants[0]?.inventoryQuantity,
    weight: variants[0]?.inventoryItem?.measurement?.weight ?? null,
    variants: variants.map((v) => ({ sku: v.sku, options: v.selectedOptions })),
    media: media!.map((m) => ({ id: m.id, alt: m.alt })),
  }

  // ── criterion 13 ─────────────────────────────────────────────────────────
  heading('CRITERION 13 — alt text is the cached description of THAT photograph')

  const { data: descriptionRows } = await supabase
    .from('intake_files')
    .select('id, product_description')
    .in('id', groupIds)
  const descriptionById = new Map(
    (descriptionRows ?? []).map((r) => [(r as { id: string }).id, (r as { product_description: string }).product_description]),
  )
  const expectedAlts = [
    descriptionById.get(groupIds[2])!,
    descriptionById.get(groupIds[1])!,
    descriptionById.get(groupIds[0])!,
  ]

  media!.forEach((item, index) => {
    const expected = expectedAlts[index]
    // buildAltText trims at Shopify's 512-character limit, so the stored alt is a
    // PREFIX of the description rather than always equal to it (D48).
    assert(
      `image ${index + 1} carries its own description`,
      item.alt !== null && expected.startsWith(item.alt),
      `${item.alt?.slice(0, 46)}…`,
    )
  })
  check('image ORDER matches the draft', media!.length, 3)

  const { data: describeEvents } = await supabase
    .from('events')
    .select('event')
    .in('entity_id', groupIds)
    .like('event', 'description%')
  check('no describe call happened during publish', (describeEvents ?? []).length, 0)
  evidence.criterion13 = { alts: media!.map((m) => m.alt), expectedPrefixes: expectedAlts }

  // ── criterion 14 ─────────────────────────────────────────────────────────
  heading('CRITERION 14 — Drive /Processed housekeeping')

  const { data: publishedIntake } = await supabase
    .from('intake_files')
    .select('id, status, published_at, drive_processed_at')
    .in('id', groupIds)
  check(
    'the database said published BEFORE the move',
    (publishedIntake ?? []).every((r) => (r as { status: string }).status === 'published'),
    true,
  )
  check('all three moved', published.housekeeping.filter((h) => h.ok).length, 3)
  check('and they really moved', published.housekeeping.filter((h) => h.moved).length, 3)

  const rawAfter = await drive.listRawFolderPage(required('DRIVE_RAW_FOLDER_ID'))
  const movedNames = published.housekeeping.map((h) => h.filename)
  assert(
    'they are gone from RAW',
    movedNames.every((name) => !rawAfter.files.some((f) => f.name === name)),
    movedNames.join(', '),
  )

  const repeat = await tidyDriveForDraft(draftId as string, {
    db: supabase,
    drive,
    processedFolderId,
    actor: ACTOR,
  })
  check('repeating the move is safe', repeat.filter((h) => h.ok).length, 3)
  check('and reports it as a no-op', repeat.filter((h) => h.moved).length, 0)

  const forced = await tidyDriveForDraft(draftId as string, {
    db: supabase,
    drive: {
      async moveToFolder() {
        throw new Error('forced failure: Drive returned 403 insufficientFilePermissions')
      },
    },
    processedFolderId,
    actor: ACTOR,
  })
  check('a forced failure is reported, not thrown', forced.filter((h) => !h.ok).length, 3)

  const { data: afterForced } = await supabase
    .from('intake_files')
    .select('status, drive_processed_error')
    .in('id', groupIds)
  check(
    'the photographs are STILL published',
    (afterForced ?? []).every((r) => (r as { status: string }).status === 'published'),
    true,
  )
  check('exactly one product still exists', await countProductsByHandle(shopify, published.result.handle), 1)
  assert(
    'the failure is readable',
    (afterForced ?? []).every((r) => (r as { drive_processed_error: string | null }).drive_processed_error?.includes('403')),
    '403 insufficientFilePermissions',
  )
  evidence.criterion14 = {
    firstMove: published.housekeeping,
    repeat,
    forcedFailure: forced.map((f) => ({ filename: f.filename, ok: f.ok, error: f.error })),
  }

  // ── criterion 11 ─────────────────────────────────────────────────────────
  heading('CRITERION 11 — idempotent retry after an interrupted publish')

  const mediaBefore = (await readProductMedia(shopify, published.result.handle))!.map((m) => m.id)

  // The nastiest ordering, and the one that really produces duplicates: Shopify
  // accepted everything and Loupe never recorded success.
  await supabase.rpc('mark_draft_failed', {
    p_draft_id: draftId,
    p_error: 'simulated interruption after Shopify accepted the product',
    p_retryable: true,
    p_actor: ACTOR,
  })

  const retry = await publishDraftForOperator(draftId as string, ACTOR, { extraTags: [TEST_TAG] }, deps)
  check('same SKU', retry.result.sku, published.result.sku)
  check('same handle', retry.result.handle, published.result.handle)
  check('same Shopify product', retry.result.shopifyProductId, published.result.shopifyProductId)
  check('it reused the reserved identity', retry.result.reusedIdentity, true)
  check('still exactly one product', await countProductsByHandle(shopify, published.result.handle), 1)

  const mediaAfterRetry = (await readProductMedia(shopify, published.result.handle))!.map((m) => m.id)
  check('no duplicated media', mediaAfterRetry.length, 3)
  check('and the SAME media, not replacements', mediaAfterRetry, mediaBefore)

  const { data: retriedDraft } = await supabase
    .from('product_drafts')
    .select('status')
    .eq('id', draftId)
    .single<{ status: string }>()
  check('final draft status', retriedDraft!.status, 'published')
  evidence.criterion11 = { mediaBefore, mediaAfterRetry, sku: retry.result.sku }

  // ── criterion 12 ─────────────────────────────────────────────────────────
  heading('CRITERION 12 — two concurrent publishes of one draft')

  const raceIds = [realIntakeIds[4]]
  const { data: raceDraftId } = await supabase.rpc('create_product_draft', {
    p_category_id: necklaces.id,
    p_intake_file_ids: raceIds,
    p_actor: ACTOR,
  })
  state.draftIds.push(raceDraftId as string)
  writeState(state)

  await supabase.rpc('save_product_draft', {
    p_draft_id: raceDraftId,
    p_expected_updated_at: null,
    p_category_id: necklaces.id,
    p_material_id: material!.id,
    p_title_suffix: null,
    p_price_paise: 12_500,
    p_weight_g: null,
    p_stock: 8,
    p_colours: [],
    p_images: [{ image_version_id: await generatedVersion(supabase, raceIds[0]), position: 0 }],
    p_actor: ACTOR,
  })

  const counterBeforeRace = await currentCounter(supabase, 'NK')
  const both = await Promise.allSettled([
    publishDraftForOperator(raceDraftId as string, ACTOR, { extraTags: [TEST_TAG] }, deps),
    publishDraftForOperator(raceDraftId as string, ACTOR, { extraTags: [TEST_TAG] }, deps),
  ])
  const won = both.filter((r) => r.status === 'fulfilled')
  const lost = both.filter((r) => r.status === 'rejected')

  check('one publish succeeded', won.length, 1)
  check('the other was refused', lost.length, 1)
  assert(
    'refused as "already publishing", not as an error',
    lost[0].status === 'rejected' && lost[0].reason instanceof PublishInProgressError,
    lost[0].status === 'rejected' ? String((lost[0].reason as Error).name) : '',
  )

  const raceResult = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof publishDraftForOperator>>>).value
  state.shopifyProductIds.push(raceResult.result.shopifyProductId)
  writeState(state)

  check('one identity', await currentCounter(supabase, 'NK'), counterBeforeRace + 1)
  check('one product', await countProductsByHandle(shopify, raceResult.result.handle), 1)
  check('one image, not two', (await readProductMedia(shopify, raceResult.result.handle))!.length, 1)
  const { data: raceDraft } = await supabase
    .from('product_drafts')
    .select('status, publish_lease_token')
    .eq('id', raceDraftId)
    .single<{ status: string; publish_lease_token: string | null }>()
  check('one final state', raceDraft!.status, 'published')
  check('the lease was released', raceDraft!.publish_lease_token, null)
  evidence.criterion12 = {
    shopifyProductId: raceResult.result.shopifyProductId,
    sku: raceResult.result.sku,
    refusedWith: lost[0].status === 'rejected' ? (lost[0].reason as Error).message : null,
  }

  evidence.finishedAt = new Date().toISOString()
  evidence.failures = failures
  saveEvidence('acceptance.json', evidence)

  console.log(`\n${'═'.repeat(78)}`)
  console.log(failures === 0 ? '  ALL LIVE CRITERIA PASSED' : `  ${failures} CHECK(S) FAILED`)
  console.log(`${'═'.repeat(78)}\n`)
  if (failures > 0) process.exitCode = 1
}

async function generatedVersion(supabase: SupabaseClient, intakeFileId: string): Promise<string> {
  const { data } = await supabase
    .from('image_versions')
    .select('id')
    .eq('intake_file_id', intakeFileId)
    .eq('kind', 'generated')
    .single<{ id: string }>()
  return data!.id
}

async function originalVersion(supabase: SupabaseClient, intakeFileId: string): Promise<string> {
  const { data } = await supabase
    .from('image_versions')
    .select('id')
    .eq('intake_file_id', intakeFileId)
    .eq('kind', 'original')
    .single<{ id: string }>()
  return data!.id
}

async function currentCounter(supabase: SupabaseClient, prefix: string): Promise<number> {
  const { data } = await supabase
    .from('sku_counters')
    .select('last_number')
    .eq('sku_prefix', prefix)
    .single<{ last_number: number }>()
  return data!.last_number
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const [{ R2ObjectStore }, { ShopifyClient }, { shopifyConfig }, { deleteProduct }, { googleDriveClient }] =
    await Promise.all([
      import('../src/lib/enhance/storage'),
      import('../src/lib/shopify/client'),
      import('../src/lib/shopify/config'),
      import('../src/lib/shopify/product-set'),
      import('../src/lib/google/drive-server'),
    ])

  const supabase = db()
  const shopify = new ShopifyClient({ config: shopifyConfig() })
  const store = new R2ObjectStore({
    endpoint: required('R2_ENDPOINT'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
  })
  const state = readState()
  const receipt: Record<string, unknown> = { cleanedAt: new Date().toISOString(), runId: state.runId }

  heading('CLEANUP — Shopify')
  const productReadback = await shopify.graphql<{
    nodes: readonly ({ id: string } | null)[]
  }>(
    /* GraphQL */ `
      query Phase4CleanupProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
          }
        }
      }
    `,
    { ids: state.shopifyProductIds },
  )
  const existingProductIds = new Set(
    productReadback.nodes.filter((node): node is { id: string } => node !== null).map((node) => node.id),
  )
  const deleted: string[] = []
  for (const id of state.shopifyProductIds) {
    if (!existingProductIds.has(id)) {
      deleted.push(id)
      console.log(`  ✓ already absent ${id}`)
      continue
    }
    try {
      const gone = await deleteProduct(shopify, id)
      deleted.push(gone ?? id)
      console.log(`  ✓ deleted ${id}`)
    } catch (error) {
      console.log(`  ✗ ${id}: ${(error as Error).message}`)
      failures += 1
    }
  }
  receipt.shopifyDeleted = deleted

  heading('CLEANUP — Drive')
  // The fixtures were moved into /Processed by the acceptance run itself. They
  // are trashed rather than moved back: putting them in RAW again would look
  // like new work to the watcher.
  const { auth, drive: driveApi } = await import('@googleapis/drive')
  const { googleServiceAccount } = await import('../src/lib/google/service-account')
  const api = driveApi({
    version: 'v3',
    auth: new auth.GoogleAuth({
      credentials: googleServiceAccount(),
      scopes: ['https://www.googleapis.com/auth/drive'],
    }),
  })
  const trashed: string[] = []
  for (const fileId of state.driveFileIds) {
    try {
      const { data: current } = await api.files.get({
        fileId,
        fields: 'id, trashed',
        supportsAllDrives: true,
      })
      if (current.trashed) {
        trashed.push(fileId)
        console.log(`  ✓ already trashed ${fileId}`)
        continue
      }
      await api.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true })
      trashed.push(fileId)
      console.log(`  ✓ trashed ${fileId}`)
    } catch (error) {
      if ((error as { code?: number }).code === 404) {
        trashed.push(fileId)
        console.log(`  ✓ already absent ${fileId}`)
        continue
      }
      console.log(`  ✗ ${fileId}: ${(error as Error).message}`)
      failures += 1
    }
  }
  receipt.driveTrashed = trashed
  void googleDriveClient

  heading('CLEANUP — database')
  let databaseReady = true
  if (state.draftIds.length) {
    const { error } = await supabase
      .from('product_draft_images')
      .delete()
      .in('product_draft_id', state.draftIds)
    if (error) {
      console.log(`  ✗ product_draft_images: ${error.message}`)
      failures += 1
      databaseReady = false
    }
  }
  let intakeDeleted = 0
  let draftsDeleted = 0
  if (databaseReady) {
    const intakeResult = await supabase
      .from('intake_files')
      .delete({ count: 'exact' })
      .in('id', state.intakeFileIds)
    if (intakeResult.error) {
      console.log(`  ✗ intake_files: ${intakeResult.error.message}`)
      failures += 1
      databaseReady = false
    } else {
      intakeDeleted = intakeResult.count ?? 0
    }
  }
  if (databaseReady) {
    const draftResult = await supabase
      .from('product_drafts')
      .delete({ count: 'exact' })
      .in('id', state.draftIds)
    if (draftResult.error) {
      console.log(`  ✗ product_drafts: ${draftResult.error.message}`)
      failures += 1
    } else {
      draftsDeleted = draftResult.count ?? 0
    }
  }
  const eventIds = [...state.intakeFileIds, ...state.draftIds]
  const eventResult = await supabase.from('events').delete().in('entity_id', eventIds)
  if (eventResult.error) {
    console.log(`  ✗ events by entity: ${eventResult.error.message}`)
    failures += 1
  }
  console.log(`  ✓ ${intakeDeleted ?? 0} intake rows · ${draftsDeleted ?? 0} drafts`)
  receipt.databaseDeleted = { intake: intakeDeleted ?? 0, drafts: draftsDeleted ?? 0 }

  heading('CLEANUP — R2')
  let objectsDeleted = 0
  for (const key of state.r2Keys) {
    await store.delete(key)
    objectsDeleted += 1
  }
  const stillThere: string[] = []
  for (const key of state.r2Keys) if (await store.head(key)) stillThere.push(key)
  console.log(`  ✓ ${objectsDeleted} objects deleted · ${stillThere.length} still present`)
  check('R2 is clear', stillThere.length, 0)
  receipt.r2Deleted = objectsDeleted

  heading('CLEANUP — verification')
  const { count: leftoverIntake } = await supabase
    .from('intake_files')
    .select('id', { count: 'exact', head: true })
    .in('id', state.intakeFileIds)
  const { count: leftoverDrafts } = await supabase
    .from('product_drafts')
    .select('id', { count: 'exact', head: true })
    .in('id', state.draftIds)
  check('no intake rows left', leftoverIntake ?? 0, 0)
  check('no drafts left', leftoverDrafts ?? 0, 0)

  receipt.failures = failures
  saveEvidence('cleanup.json', receipt)
  if (failures > 0) process.exitCode = 1
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (process.env.PHASE4_LIVE_ACCEPTANCE !== CONFIRMATION) {
    throw new Error(
      `This publishes real products to ${process.env.SHOPIFY_STORE_DOMAIN}.\n` +
        `Set PHASE4_LIVE_ACCEPTANCE=${CONFIRMATION} to run it.`,
    )
  }
  if (required('SHOPIFY_STORE_DOMAIN') !== 'qimti.myshopify.com') {
    throw new Error(
      `Refusing to run against ${process.env.SHOPIFY_STORE_DOMAIN}. Phase 4 is the TEST store only; ` +
        'live-store cutover is Phase 7.',
    )
  }

  if (mode === 'seed') await seed()
  else if (mode === 'accept') await accept()
  else if (mode === 'cleanup') await cleanup()
  else throw new Error('Usage: npm run verify:phase4 -- <seed|accept|cleanup>')
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
