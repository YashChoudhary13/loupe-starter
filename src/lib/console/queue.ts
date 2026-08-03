import 'server-only'

import { supabaseServer } from '@/lib/supabase/server'
import { loadDuplicateCandidates } from '@/lib/duplicates/read-model'

import { signKeys } from './images'
import { startOfKolkataDayIso } from './queue-view'
import type {
  ColourSuggestion,
  ConsoleCatalog,
  DraftDetail,
  DraftImageRef,
  MaterialOption,
  PhotoSummary,
  PipelineActivity,
  QueueSnapshot,
  QueueTile,
  VersionSummary,
} from './types'

/**
 * The console's read model.
 *
 * All of it runs on the server with the service-role key. The browser never
 * queries Supabase — every table has RLS enabled with zero policies (D11), so it
 * could not even if it tried, and Phase 4 deliberately adds no policy to make
 * the UI easier. What the browser gets is the projection in ./types.ts.
 *
 * The queue mixes two things on purpose, because that is what the operator is
 * actually looking at: photographs nobody has grouped yet, and products
 * part-built. Failed and retrying infrastructure rows are counted, not detailed —
 * that is the Phase 6 tracking page and building it here would be building ahead.
 */

/** CLAUDE.md hard rule 5: alert on AGE, not status. */
export const STALE_UNGROUPED_HOURS = 24

/**
 * Queue caps, sized against the real operating volume (100-200 products/day)
 * and the way the batch is actually worked: the operator builds 100-150 drafts
 * and only then publishes them.
 *
 * DRAFT_LIMIT was 120 — BELOW that batch size. Drafts past the cap simply did
 * not appear in the console, which for an operator is indistinguishable from
 * having lost them. PHOTO_LIMIT was 240, barely one day of intake, so falling a
 * day behind hid the oldest photographs.
 *
 * These are still caps, not "all rows" — an unbounded query is how one bad day
 * takes the console down. `truncated` on the snapshot says so out loud rather
 * than silently showing a subset.
 */
const PHOTO_LIMIT = 600
const DRAFT_LIMIT = 500

interface IntakeRow {
  id: string
  filename: string
  status: string
  discovered_at: string
  product_description: string | null
  description_missing_at: string | null
  presentation_class: string | null
  product_draft_id: string | null
}

interface VersionRow {
  id: string
  intake_file_id: string
  kind: 'original' | 'generated'
  version_no: number
  is_selected: boolean
  model: string | null
  width: number | null
  height: number | null
  created_at: string
  storage_key: string
  thumb_key: string | null
}

interface RedoRow {
  id: string
  intake_file_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  version_no: number
  last_error: string | null
  created_at: string
}

interface CategoryRow {
  id: string
  name: string
  sku_prefix: string
  title_pattern: string
  shopify_tag: string | null
  default_weight_g: number | null
  default_stock: number
}

interface DraftRow {
  id: string
  status: 'assembling' | 'publishing' | 'published' | 'failed'
  updated_at: string
  category_id: string
  material_id: string | null
  custom_material: string | null
  description_override: string | null
  title_suffix: string | null
  price_paise: number | null
  weight_g: number | null
  stock: number
  variant_kind: 'none' | 'colour' | 'number'
  reserved_sku: string | null
  reserved_handle: string | null
  shopify_product_id: string | null
  error: string | null
  publish_lease_expires_at: string | null
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000
}

/** The version a tile should show: the pipeline's pick, else the newest. */
function preferredVersion(versions: readonly VersionRow[]): VersionRow | undefined {
  return [...versions].sort(
    (a, b) => Number(b.is_selected) - Number(a.is_selected) || b.version_no - a.version_no,
  )[0]
}

async function latestRedos(intakeFileIds: readonly string[]): Promise<Map<string, RedoRow>> {
  if (intakeFileIds.length === 0) return new Map()
  const { data, error } = await supabaseServer()
    .from('image_redo_jobs')
    .select('id, intake_file_id, status, version_no, last_error, created_at')
    .in('intake_file_id', intakeFileIds)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`image_redo_jobs: ${error.message}`)

  const byIntake = new Map<string, RedoRow>()
  for (const row of (data ?? []) as RedoRow[]) {
    if (!byIntake.has(row.intake_file_id)) byIntake.set(row.intake_file_id, row)
  }
  return byIntake
}

function redoSummary(row: RedoRow | undefined): PhotoSummary['redo'] {
  return row
    ? {
        jobId: row.id,
        status: row.status,
        versionNo: row.version_no,
        error: row.last_error,
        createdAt: row.created_at,
      }
    : null
}

export async function loadCatalog(): Promise<ConsoleCatalog> {
  const db = supabaseServer()

  const [{ data: categories, error: categoryError }, { data: counters, error: counterError }, { data: materials, error: materialError }] =
    await Promise.all([
      db
        .from('categories')
        .select('id, name, sku_prefix, title_pattern, shopify_tag, default_weight_g, default_stock')
        .eq('active', true)
        .order('sort_order', { ascending: true }),
      db.from('sku_counters').select('sku_prefix, last_number'),
      db.from('materials').select('id, name').eq('active', true).order('sort_order', { ascending: true }),
    ])

  if (categoryError) throw new Error(`categories: ${categoryError.message}`)
  if (counterError) throw new Error(`sku_counters: ${counterError.message}`)
  if (materialError) throw new Error(`materials: ${materialError.message}`)

  const lastNumbers = new Map(
    ((counters ?? []) as { sku_prefix: string; last_number: number }[]).map((c) => [
      c.sku_prefix,
      c.last_number,
    ]),
  )

  return {
    categories: ((categories ?? []) as CategoryRow[]).map((c) => ({
      id: c.id,
      name: c.name,
      skuPrefix: c.sku_prefix,
      titlePattern: c.title_pattern,
      shopifyTag: c.shopify_tag,
      defaultWeightG: c.default_weight_g,
      defaultStock: c.default_stock,
      lastNumber: lastNumbers.get(c.sku_prefix) ?? 0,
    })),
    materials: ((materials ?? []) as MaterialOption[]).map((m) => ({ id: m.id, name: m.name })),
  }
}

/**
 * Colour suggestions, ranked by how often they have been PUBLISHED in this
 * category — Necklaces surface Gold/Silver, Rings surface Red/White/Green
 * (CLAUDE.md · Colours). A single global ranking would offer the wrong ones.
 */
export async function loadColourSuggestions(categoryId: string): Promise<readonly ColourSuggestion[]> {
  const db = supabaseServer()
  const { data, error } = await db
    .from('colour_usage')
    .select('usage_count, last_used_at, colours ( name, archived_at )')
    .eq('category_id', categoryId)
    .order('usage_count', { ascending: false })
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .limit(12)
  if (error) throw new Error(`colour_usage: ${error.message}`)

  return (data ?? [])
    .map((row) => {
      const embedded = (row as { colours?: unknown }).colours
      const one = Array.isArray(embedded) ? embedded[0] : embedded
      const colour = one as { name?: unknown; archived_at?: unknown } | null | undefined
      if (typeof colour?.name !== 'string' || colour.archived_at) return null
      return {
        name: colour.name,
        usageCount: (row as { usage_count: number }).usage_count,
      }
    })
    .filter((c): c is ColourSuggestion => c !== null)
}

/**
 * Just the pipeline counters — two COUNT queries, no rows, no presigned URLs.
 *
 * This exists so the console can watch Drive intake progress every few seconds
 * without paying for `loadQueue()`. A full snapshot re-signs every thumbnail,
 * and a presigned URL is different on every call, so polling the full snapshot
 * changed every `img src` on the page and made the browser re-download the whole
 * grid — which is what made the console feel stuck and swallow clicks.
 *
 * `uploading` deliberately counts only `attempts = 0`. A row in retry backoff is
 * also `discovered`, but it is waiting on a bounded retry (D29), not uploading:
 * counting it held the console in fast-poll mode for up to an hour and told the
 * operator a photograph was in progress when nothing was happening to it. That
 * state belongs to Tracking, which alerts on age and failure (hard rule 5).
 */
export async function loadPipelineActivity(): Promise<PipelineActivity> {
  const db = supabaseServer()
  const [uploadingResult, processingResult] = await Promise.all([
    db
      .from('intake_files')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'discovered')
      .eq('attempts', 0),
    db.from('intake_files').select('id', { count: 'exact', head: true }).eq('status', 'enhancing'),
  ])
  if (uploadingResult.error) throw new Error(`intake_files (discovered): ${uploadingResult.error.message}`)
  if (processingResult.error) throw new Error(`intake_files (enhancing): ${processingResult.error.message}`)

  return {
    uploading: uploadingResult.count ?? 0,
    processing: processingResult.count ?? 0,
  }
}

export async function loadQueue(): Promise<QueueSnapshot> {
  const db = supabaseServer()
  const startOfToday = startOfKolkataDayIso(new Date())

  const [photosResult, draftsResult, publishedResult, categoriesResult, uploadingResult, processingResult] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'id, filename, status, discovered_at, product_description, description_missing_at, presentation_class, product_draft_id',
      )
      .eq('status', 'enhanced')
      .is('product_draft_id', null)
      .order('discovered_at', { ascending: true })
      .limit(PHOTO_LIMIT),
    db
      .from('product_drafts')
      .select(
        'id, status, updated_at, category_id, material_id, custom_material, description_override, title_suffix, price_paise, weight_g, stock, variant_kind, reserved_sku, reserved_handle, shopify_product_id, error, publish_lease_expires_at',
      )
      .in('status', ['assembling', 'publishing', 'failed'])
      .order('updated_at', { ascending: false })
      .limit(DRAFT_LIMIT),
    db
      .from('product_drafts')
      .select(
        'id, status, updated_at, category_id, material_id, custom_material, description_override, title_suffix, price_paise, weight_g, stock, variant_kind, reserved_sku, reserved_handle, shopify_product_id, error, publish_lease_expires_at',
        { count: 'exact' },
      )
      .eq('status', 'published')
      .gte('published_at', startOfToday)
      .order('published_at', { ascending: false })
      .limit(DRAFT_LIMIT),
    db.from('categories').select('id, name'),
    db
      .from('intake_files')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'discovered')
      .eq('attempts', 0),
    db.from('intake_files').select('id', { count: 'exact', head: true }).eq('status', 'enhancing'),
  ])

  if (photosResult.error) throw new Error(`intake_files: ${photosResult.error.message}`)
  if (draftsResult.error) throw new Error(`product_drafts: ${draftsResult.error.message}`)
  if (publishedResult.error) {
    throw new Error(`product_drafts (published): ${publishedResult.error.message}`)
  }
  if (categoriesResult.error) throw new Error(`categories: ${categoriesResult.error.message}`)
  if (uploadingResult.error) throw new Error(`intake_files (discovered): ${uploadingResult.error.message}`)
  if (processingResult.error) throw new Error(`intake_files (enhancing): ${processingResult.error.message}`)

  const photos = (photosResult.data ?? []) as IntakeRow[]
  const drafts = (draftsResult.data ?? []) as DraftRow[]
  const publishedDrafts = (publishedResult.data ?? []) as DraftRow[]
  const categoryNames = new Map(
    ((categoriesResult.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  )
  const duplicateCandidates = await loadDuplicateCandidates(photos.map((photo) => photo.id))
  const duplicateByIntake = new Map(
    duplicateCandidates.map((candidate) => [candidate.intakeFileId, candidate]),
  )

  const draftIds = [...drafts, ...publishedDrafts].map((d) => d.id)
  const { data: draftPhotoRows, error: draftPhotoError } = draftIds.length
    ? await db
        .from('intake_files')
        .select('id, filename, status, discovered_at, product_draft_id')
        .in('product_draft_id', draftIds)
    : { data: [], error: null }
  if (draftPhotoError) throw new Error(`intake_files (grouped): ${draftPhotoError.message}`)
  const draftPhotos = (draftPhotoRows ?? []) as IntakeRow[]

  const allIntakeIds = [...photos.map((p) => p.id), ...draftPhotos.map((p) => p.id)]
  const { data: versionRows, error: versionError } = allIntakeIds.length
    ? await db
        .from('image_versions')
        .select(
          'id, intake_file_id, kind, version_no, is_selected, model, width, height, created_at, storage_key, thumb_key',
        )
        .in('intake_file_id', allIntakeIds)
    : { data: [], error: null }
  if (versionError) throw new Error(`image_versions: ${versionError.message}`)

  const versionsByIntake = new Map<string, VersionRow[]>()
  for (const version of (versionRows ?? []) as VersionRow[]) {
    const list = versionsByIntake.get(version.intake_file_id) ?? []
    list.push(version)
    versionsByIntake.set(version.intake_file_id, list)
  }

  // One presigned URL per distinct object, for the tiles only. The grid never
  // loads a full-resolution image; that is what the thumbnails exist for.
  const thumbKeys: (string | null)[] = []
  for (const photo of [...photos, ...draftPhotos]) {
    const version = preferredVersion(versionsByIntake.get(photo.id) ?? [])
    thumbKeys.push(version?.thumb_key ?? null)
  }
  const signed = await signKeys(thumbKeys)

  function tileThumb(intakeFileId: string) {
    const version = preferredVersion(versionsByIntake.get(intakeFileId) ?? [])
    return (version?.thumb_key ? signed.get(version.thumb_key) : null) ?? null
  }

  const photoTiles: QueueTile[] = photos.map((photo) => ({
    kind: 'photo',
    id: photo.id,
    label: photo.filename,
    thumb: tileThumb(photo.id),
    imageCount: 1,
    categoryName: null,
    status: photo.status,
    // Hard rule 5. An ungrouped enhanced photo is normal — it is waiting for an
    // operator. The same photo still waiting tomorrow is a problem.
    attention:
      duplicateByIntake.has(photo.id)
        ? `Possible duplicate of ${duplicateByIntake.get(photo.id)!.matchFilename}`
        : hoursSince(photo.discovered_at) >= STALE_UNGROUPED_HOURS
          ? `Waiting ${Math.floor(hoursSince(photo.discovered_at) / 24)}d for an operator`
          : null,
    reservedSku: null,
  }))

  const photosByDraft = new Map<string, IntakeRow[]>()
  for (const photo of draftPhotos) {
    if (!photo.product_draft_id) continue
    const list = photosByDraft.get(photo.product_draft_id) ?? []
    list.push(photo)
    photosByDraft.set(photo.product_draft_id, list)
  }

  function toDraftTile(draft: DraftRow): QueueTile {
    const members = photosByDraft.get(draft.id) ?? []
    const first = [...members].sort((a, b) => a.discovered_at.localeCompare(b.discovered_at))[0]
    const leaseHeld =
      draft.publish_lease_expires_at !== null &&
      new Date(draft.publish_lease_expires_at).getTime() > Date.now()

    return {
      kind: 'draft',
      id: draft.id,
      label: categoryNames.get(draft.category_id) ?? 'Product',
      thumb: first ? tileThumb(first.id) : null,
      imageCount: members.length,
      categoryName: categoryNames.get(draft.category_id) ?? null,
      status: draft.status,
      attention:
        draft.status === 'failed'
          ? 'Publish failed — retry reuses the same product'
          : draft.status === 'publishing' && !leaseHeld
            ? 'Publish was interrupted — retry to finish it'
            : null,
      reservedSku: draft.reserved_sku,
    }
  }

  const draftTiles = drafts.map(toDraftTile)
  const listedTodayTiles = publishedDrafts.map(toDraftTile)
  const tiles = [...draftTiles, ...photoTiles]
  const expiries = [...tiles, ...listedTodayTiles]
    .map((t) => t.thumb?.expiresAt)
    .filter((e): e is number => typeof e === 'number')

  return {
    tiles,
    listedTodayTiles,
    ungroupedCount: photoTiles.length,
    draftCount: draftTiles.length,
    publishedToday: publishedResult.count ?? 0,
    // Silent truncation is the bug; a visible cap is a limitation.
    truncated: photos.length >= PHOTO_LIMIT || drafts.length >= DRAFT_LIMIT,
    attentionCount: tiles.filter((t) => t.attention !== null).length,
    pipelineActivity: {
      uploading: uploadingResult.count ?? 0,
      processing: processingResult.count ?? 0,
    },
    signedUntil: expiries.length ? Math.min(...expiries) : Date.now() + 15 * 60 * 1000,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * The versions of a set of photographs, with full images signed.
 *
 * Used by the "new product" panel, where the operator is looking at photographs
 * that are not in a draft yet and still has to be able to review them large and
 * choose between original and generated before anything is created. It is
 * per-selection rather than per-tile, so the queue grid stays thumbnails-only.
 */
export async function loadPhotos(intakeFileIds: readonly string[]): Promise<readonly PhotoSummary[]> {
  if (intakeFileIds.length === 0) return []
  const db = supabaseServer()

  const [filesResult, versionsResult] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'id, filename, status, discovered_at, product_description, description_missing_at, presentation_class, product_draft_id',
      )
      .in('id', intakeFileIds),
    db
      .from('image_versions')
      .select(
        'id, intake_file_id, kind, version_no, is_selected, model, width, height, created_at, storage_key, thumb_key',
      )
      .in('intake_file_id', intakeFileIds)
      .order('version_no', { ascending: true }),
  ])
  if (filesResult.error) throw new Error(`intake_files: ${filesResult.error.message}`)
  if (versionsResult.error) throw new Error(`image_versions: ${versionsResult.error.message}`)

  const files = (filesResult.data ?? []) as IntakeRow[]
  const versions = (versionsResult.data ?? []) as VersionRow[]
  const redos = await latestRedos(intakeFileIds)
  const duplicateCandidates = await loadDuplicateCandidates(intakeFileIds)
  const duplicateByIntake = new Map(
    duplicateCandidates.map((candidate) => [candidate.intakeFileId, candidate]),
  )
  const signed = await signKeys([
    ...versions.map((v) => v.thumb_key),
    ...versions.map((v) => v.storage_key),
  ])

  const byIntake = new Map<string, VersionRow[]>()
  for (const version of versions) {
    const list = byIntake.get(version.intake_file_id) ?? []
    list.push(version)
    byIntake.set(version.intake_file_id, list)
  }

  // Preserve the caller's order — it is the order the operator selected in.
  const order = new Map(intakeFileIds.map((id, index) => [id, index]))
  return files
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((file) => ({
      intakeFileId: file.id,
      filename: file.filename,
      status: file.status,
      discoveredAt: file.discovered_at,
      description: file.product_description,
      descriptionMissing: file.description_missing_at !== null,
      presentationClass: file.presentation_class,
      possibleDuplicate: duplicateByIntake.has(file.id)
        ? {
            matchIntakeFileId: duplicateByIntake.get(file.id)!.matchIntakeFileId,
            matchFilename: duplicateByIntake.get(file.id)!.matchFilename,
            distance: duplicateByIntake.get(file.id)!.distance,
          }
        : null,
      versions: (byIntake.get(file.id) ?? [])
        .sort((a, b) => a.version_no - b.version_no)
        .map((v) => toVersionSummary(v, signed)),
      redo: redoSummary(redos.get(file.id)),
    }))
}

function toVersionSummary(
  row: VersionRow,
  signed: Map<string, { url: string; expiresAt: number }>,
): VersionSummary {
  return {
    id: row.id,
    kind: row.kind,
    versionNo: row.version_no,
    isSelected: row.is_selected,
    model: row.model,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    thumb: (row.thumb_key ? signed.get(row.thumb_key) : null) ?? null,
    full: signed.get(row.storage_key) ?? null,
  }
}

export async function loadDraft(draftId: string): Promise<DraftDetail | null> {
  const db = supabaseServer()

  const { data: draftRow, error: draftError } = await db
    .from('product_drafts')
    .select(
      'id, status, updated_at, category_id, material_id, custom_material, description_override, title_suffix, price_paise, weight_g, stock, variant_kind, reserved_sku, reserved_handle, shopify_product_id, error, publish_lease_expires_at',
    )
    .eq('id', draftId)
    .maybeSingle<DraftRow>()
  if (draftError) throw new Error(`product_drafts: ${draftError.message}`)
  if (!draftRow) return null

  const [photosResult, imagesResult, variantsResult] = await Promise.all([
    db
      .from('intake_files')
      .select(
        'id, filename, status, discovered_at, product_description, description_missing_at, presentation_class, product_draft_id',
      )
      .eq('product_draft_id', draftId)
      .order('discovered_at', { ascending: true }),
    db
      .from('product_draft_images')
      .select('image_version_id, position, shopify_media_id')
      .eq('product_draft_id', draftId)
      .order('position', { ascending: true }),
    db
      .from('product_draft_variants')
      .select('position, option_value, stock')
      .eq('product_draft_id', draftId)
      .order('position', { ascending: true }),
  ])

  if (photosResult.error) throw new Error(`intake_files: ${photosResult.error.message}`)
  if (imagesResult.error) throw new Error(`product_draft_images: ${imagesResult.error.message}`)
  if (variantsResult.error) throw new Error(`product_draft_variants: ${variantsResult.error.message}`)

  const photos = (photosResult.data ?? []) as IntakeRow[]

  const { data: versionRows, error: versionError } = photos.length
    ? await db
        .from('image_versions')
        .select(
          'id, intake_file_id, kind, version_no, is_selected, model, width, height, created_at, storage_key, thumb_key',
        )
        .in(
          'intake_file_id',
          photos.map((p) => p.id),
        )
        .order('version_no', { ascending: true })
    : { data: [], error: null }
  if (versionError) throw new Error(`image_versions: ${versionError.message}`)
  const versions = (versionRows ?? []) as VersionRow[]
  const redos = await latestRedos(photos.map((photo) => photo.id))
  const duplicateCandidates = await loadDuplicateCandidates(photos.map((photo) => photo.id))
  const duplicateByIntake = new Map(
    duplicateCandidates.map((candidate) => [candidate.intakeFileId, candidate]),
  )

  // Here the full images ARE signed: the editor shows one large review image and
  // lets the operator compare versions. That is the "larger review" case, and it
  // is per-draft rather than per-tile.
  const signed = await signKeys([
    ...versions.map((v) => v.thumb_key),
    ...versions.map((v) => v.storage_key),
  ])

  const versionsByIntake = new Map<string, VersionRow[]>()
  for (const version of versions) {
    const list = versionsByIntake.get(version.intake_file_id) ?? []
    list.push(version)
    versionsByIntake.set(version.intake_file_id, list)
  }
  const intakeByVersion = new Map(versions.map((v) => [v.id, v.intake_file_id]))

  const photoSummaries: PhotoSummary[] = photos.map((photo) => ({
    intakeFileId: photo.id,
    filename: photo.filename,
    status: photo.status,
    discoveredAt: photo.discovered_at,
    description: photo.product_description,
    descriptionMissing: photo.description_missing_at !== null,
    presentationClass: photo.presentation_class,
    possibleDuplicate: duplicateByIntake.has(photo.id)
      ? {
          matchIntakeFileId: duplicateByIntake.get(photo.id)!.matchIntakeFileId,
          matchFilename: duplicateByIntake.get(photo.id)!.matchFilename,
          distance: duplicateByIntake.get(photo.id)!.distance,
        }
      : null,
    versions: (versionsByIntake.get(photo.id) ?? [])
      .sort((a, b) => a.version_no - b.version_no)
      .map((v) => toVersionSummary(v, signed)),
    redo: redoSummary(redos.get(photo.id)),
  }))

  const images: DraftImageRef[] = (
    (imagesResult.data ?? []) as {
      image_version_id: string
      position: number
      shopify_media_id: string | null
    }[]
  ).map((row) => ({
    imageVersionId: row.image_version_id,
    intakeFileId: intakeByVersion.get(row.image_version_id) ?? '',
    position: row.position,
    shopifyMediaId: row.shopify_media_id,
  }))

  const variants = (
    (variantsResult.data ?? []) as {
      position: number
      option_value: string
      stock: number
    }[]
  ).map((row) => ({ value: row.option_value, stock: row.stock, position: row.position }))

  return {
    id: draftRow.id,
    status: draftRow.status,
    updatedAt: draftRow.updated_at,
    categoryId: draftRow.category_id,
    materialId: draftRow.material_id,
    customMaterial: draftRow.custom_material,
    descriptionOverride: draftRow.description_override,
    titleSuffix: draftRow.title_suffix,
    pricePaise: draftRow.price_paise,
    weightG: draftRow.weight_g,
    variantKind: draftRow.variant_kind,
    variants,
    stock: draftRow.stock,
    reservedSku: draftRow.reserved_sku,
    reservedHandle: draftRow.reserved_handle,
    shopifyProductId: draftRow.shopify_product_id,
    error: draftRow.error,
    publishInFlight:
      draftRow.publish_lease_expires_at !== null &&
      new Date(draftRow.publish_lease_expires_at).getTime() > Date.now(),
    photos: photoSummaries,
    images,
  }
}
