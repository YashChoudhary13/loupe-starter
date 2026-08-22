import 'server-only'

import sharp from 'sharp'

import type { Operator } from '@/lib/auth/authorize'
import { consoleObjectStore } from '@/lib/console/images'
import { ConsoleError } from '@/lib/console/mutations'
import { makeThumbnail } from '@/lib/enhance/image'
import { googleDriveClient } from '@/lib/google/drive-server'
import { ensurePromptPair } from '@/lib/prompts/ensure-pair'
import { ShopifyClient } from '@/lib/shopify/client'
import { setAvailableQuantities } from '@/lib/shopify/inventory'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * The two restock paths (D112). Loupe's state moves through begin_* / complete_*
 * RPCs; the Shopify write sits between them, and a failure there is recorded on
 * the decision so the operator can retry from the Restock section.
 */

interface IntakeSource {
  id: string
  filename: string
  mime_type: string | null
  source: 'drive' | 'upload' | 'manual'
  source_storage_key: string | null
  drive_file_id: string
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tif' }

async function loadIntake(intakeFileId: string): Promise<IntakeSource> {
  const { data, error } = await supabaseServer()
    .from('intake_files')
    .select('id, filename, mime_type, source, source_storage_key, drive_file_id')
    .eq('id', intakeFileId)
    .maybeSingle<IntakeSource>()
  if (error || !data) throw new ConsoleError('That photograph no longer exists.', error?.message ?? null, false)
  return data
}

/**
 * The bytes of the photograph as an R2 key Loupe owns. An upload already has
 * them; a Drive photograph that never reached enhancement is copied to the
 * immutable originals/ key the enhancement worker would have used.
 */
async function materialiseOriginal(intake: IntakeSource): Promise<{ storageKey: string; thumbKey: string; width: number; height: number }> {
  const store = consoleObjectStore()
  let bytes: Buffer
  let storageKey: string
  let thumbKey: string
  if (intake.source_storage_key) {
    storageKey = intake.source_storage_key
    thumbKey = `${storageKey.slice(0, storageKey.lastIndexOf('/'))}/thumb.webp`
    bytes = await store.get(storageKey)
  } else {
    bytes = await googleDriveClient().downloadFile(intake.drive_file_id)
    const ext = EXT[intake.mime_type ?? ''] ?? 'jpg'
    storageKey = `originals/${intake.id}.${ext}`
    thumbKey = `originals/${intake.id}_thumb.webp`
    await store.putImmutable(storageKey, bytes, intake.mime_type ?? 'image/jpeg', { 'intake-id': intake.id, 'drive-file-id': intake.drive_file_id, source: 'restock' })
    if (!(await store.head(thumbKey))) {
      await store.putImmutable(thumbKey, await makeThumbnail(bytes), 'image/webp', { 'intake-id': intake.id, source: 'restock' })
    }
  }
  const meta = await sharp(bytes, { failOn: 'error' }).metadata()
  const oriented = meta.autoOrient ?? { width: meta.width, height: meta.height }
  return { storageKey, thumbKey, width: oriented.width ?? meta.width ?? 1, height: oriented.height ?? meta.height ?? 1 }
}

export interface RestockQuantity {
  readonly inventoryItemId: string
  readonly label: string
  readonly before: number
  readonly after: number
}

export async function restockExisting(
  operator: Operator,
  input: { intakeFileId: string; productId: string; quantities: readonly RestockQuantity[] },
): Promise<void> {
  const db = supabaseServer()
  if (input.quantities.length === 0) throw new ConsoleError('Enter the new stock for at least one variant.', null, false)
  const { data: decisionId, error: beginError } = await db.rpc('begin_restock_existing', {
    p_intake_file_id: input.intakeFileId,
    p_old_product_id: input.productId,
    p_quantities: input.quantities.map((q) => ({ inventory_item_id: q.inventoryItemId, label: q.label, before: q.before, after: q.after })),
    p_actor: operator.email,
  })
  if (beginError || typeof decisionId !== 'string') {
    throw new ConsoleError(beginError?.hint || beginError?.message || 'The restock could not be started.', beginError?.message ?? null, false)
  }
  try {
    await setAvailableQuantities(
      new ShopifyClient(),
      input.quantities.map((q) => ({ inventoryItemId: q.inventoryItemId, quantity: q.after })),
      `loupe://restock/${decisionId}`,
    )
    const intake = await loadIntake(input.intakeFileId)
    const { storageKey } = await materialiseOriginal(intake)
    const { error } = await db.rpc('complete_restock_existing', { p_decision_id: decisionId, p_reference_key: storageKey, p_actor: operator.email })
    if (error) throw new Error(error.message)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await db.rpc('fail_restock', { p_decision_id: decisionId, p_error: message, p_actor: operator.email })
    throw new ConsoleError('The stock change did not go through. Nothing was recorded as done; fix the cause and try again.', message, true)
  }
}

export async function newSkuFromRestock(
  operator: Operator,
  input: { intakeFileId: string; productId: string | null; wantsNewImage: boolean; categorySlug: string | null; settingSlug: string | null },
): Promise<void> {
  const db = supabaseServer()
  const intake = await loadIntake(input.intakeFileId)
  let presetSlug: string | null = null
  let original: { storageKey: string; thumbKey: string; width: number; height: number } | null = null
  if (input.wantsNewImage) {
    if (input.categorySlug && input.settingSlug) presetSlug = await ensurePromptPair(input.categorySlug, input.settingSlug, operator.email)
  } else {
    original = await materialiseOriginal(intake)
  }
  const { error } = await db.rpc('begin_new_sku_from_restock', {
    p_intake_file_id: input.intakeFileId,
    p_old_product_id: input.productId,
    p_wants_new_image: input.wantsNewImage,
    p_preset_slug: presetSlug,
    p_storage_key: original?.storageKey ?? null,
    p_thumb_key: original?.thumbKey ?? null,
    p_width: original?.width ?? null,
    p_height: original?.height ?? null,
    p_actor: operator.email,
  })
  if (error) throw new ConsoleError(error.hint || error.message, error.message, false)
}

export async function saveReferenceOnly(
  operator: Operator,
  input: { intakeFileId: string; decisionId: string; sku: string | null },
): Promise<void> {
  const db = supabaseServer()
  const intake = await loadIntake(input.intakeFileId)
  const { storageKey } = await materialiseOriginal(intake)
  const { error } = await db.rpc('save_restock_reference', {
    p_decision_id: input.decisionId,
    p_sku: input.sku,
    p_reference_key: storageKey,
    p_actor: operator.email,
  })
  if (error) throw new ConsoleError(error.hint || error.message, error.message, false)
}

export async function reopenIdentification(operator: Operator, intakeFileId: string): Promise<void> {
  const { error } = await supabaseServer().rpc('reopen_identification', { p_intake_file_id: intakeFileId, p_actor: operator.email })
  if (error) throw new ConsoleError(error.hint || error.message, error.message, false)
}
