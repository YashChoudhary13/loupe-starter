import 'server-only'

import { createHash } from 'node:crypto'

import type { Operator } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import type { AgentSuggest, AgentTag } from '@/lib/console/types'
import { perceptualHash } from '@/lib/duplicates/phash'
import { serverEnv } from '@/lib/env'
import { makeThumbnail, readImageDimensions } from '@/lib/images/image'
import { R2ObjectStore } from '@/lib/images/storage'
import { beginManualUpload, verifyUploadedObject } from '@/lib/manual-upload/server'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * D142: Claude delivers finished product images here. Each one becomes an ordinary
 * ready (manual, AI-bypassed) intake row — the same R2 keys, thumbnail, pHash and
 * selected original as the console's own "Upload images" — plus the agent's tag,
 * note, restock SKU and listing suggestion.
 */

/** The actor every agent upload is owned by; `manual_uploads.created_by` and the finalise check compare against it. */
export const AGENT_OPERATOR: Operator = { id: 'agent', email: 'agent@claude.local', name: 'Claude', role: 'operator' }
export const AGENT_IMAGE_MAX_BYTES = 25_000_000

export interface AgentImageInput {
  readonly bytes: Buffer
  readonly filename: string
  readonly mimeType: string
  readonly tag: AgentTag
  readonly note: string | null
  readonly restockSku: string | null
  readonly suggest: AgentSuggest | null
  readonly batch: string | null
  /** D145: the supplier photograph (by filename inside the batch) this render came from. */
  readonly sourceFilename: string | null
}

export interface AgentImageResult {
  readonly intakeId: string
  readonly status: string
  readonly duplicate: boolean
}

function objectStore(): R2ObjectStore {
  return new R2ObjectStore({
    endpoint: serverEnv.r2Endpoint,
    accessKeyId: serverEnv.r2AccessKeyId,
    secretAccessKey: serverEnv.r2SecretAccessKey,
    bucket: serverEnv.r2Bucket,
  })
}

async function findDuplicate(sha256: string): Promise<AgentImageResult | null> {
  const { data, error } = await supabaseServer()
    .from('intake_files').select('id, status').eq('agent_sha256', sha256).limit(1).maybeSingle<{ id: string; status: string }>()
  if (error) throw new ConsoleError('The duplicate check failed.', error.message, true)
  return data ? { intakeId: data.id, status: data.status, duplicate: true } : null
}

/** D145: the job photo named by `source_filename` in the batch (job label), or null when there is none. */
async function findSourcePhoto(batch: string | null, sourceFilename: string | null): Promise<string | null> {
  if (!batch || !sourceFilename) return null
  const db = supabaseServer()
  const { data: job } = await db.from('agent_jobs').select('id').eq('label', batch).maybeSingle<{ id: string }>()
  if (!job) return null
  const { data: photo } = await db.from('agent_job_photos').select('id').eq('job_id', job.id).eq('filename', sourceFilename).eq('status', 'uploaded')
    .limit(1).maybeSingle<{ id: string }>()
  return photo?.id ?? null
}

function parsed(data: unknown): AgentImageResult {
  const row = data as { intake_id?: unknown; status?: unknown; duplicate?: unknown } | null
  if (!row || typeof row.intake_id !== 'string') throw new ConsoleError('The database returned no intake id.', null, true)
  return { intakeId: row.intake_id, status: typeof row.status === 'string' ? row.status : 'enhanced', duplicate: row.duplicate === true }
}

export async function ingestAgentImage(input: AgentImageInput): Promise<AgentImageResult> {
  if (input.bytes.byteLength === 0) throw new ConsoleError('The file is empty.', null, false)
  if (input.bytes.byteLength > AGENT_IMAGE_MAX_BYTES) throw new ConsoleError('The file is larger than 25 MB.', null, false)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const db = supabaseServer()
  const existing = await findDuplicate(sha256)
  if (existing) return existing

  const ticket = await beginManualUpload(AGENT_OPERATOR, {
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes.byteLength,
  })
  const { data: upload, error: uploadError } = await db
    .from('manual_uploads')
    .select('storage_key')
    .eq('id', ticket.uploadId)
    .maybeSingle<{ storage_key: string }>()
  if (uploadError || !upload) throw new ConsoleError('The upload row could not be read back.', uploadError?.message ?? null, true)

  await objectStore().putImmutable(upload.storage_key, input.bytes, input.mimeType, { 'manual-upload-id': ticket.uploadId, source: 'agent-image' })

  const verified = await verifyUploadedObject(AGENT_OPERATOR, ticket.uploadId)
  if ('completed' in verified) return { intakeId: verified.completed, status: 'enhanced', duplicate: true }

  const { data, error } = await db.rpc('finalize_agent_image_upload', {
    p_upload_id: verified.upload.id,
    p_thumb_key: verified.thumbnailKey,
    p_width: verified.width,
    p_height: verified.height,
    p_phash: verified.phash,
    p_actor: AGENT_OPERATOR.email,
    p_tag: input.tag,
    p_note: input.note,
    p_restock_sku: input.restockSku,
    p_suggest: input.suggest,
    p_sha256: sha256,
    p_batch: input.batch,
  })
  if (error) throw new ConsoleError('The image is safely uploaded, but it could not be added to Pending.', error.message, true)
  const result = parsed(data)
  const sourcePhotoId = await findSourcePhoto(input.batch, input.sourceFilename)
  if (sourcePhotoId && !result.duplicate) {
    // ponytail: one extra update instead of a wider finalise signature; a miss here only loses the redo shortcut.
    await db.from('intake_files').update({ agent_source_photo_id: sourcePhotoId }).eq('id', result.intakeId)
  }
  return result
}

export interface AgentReplaceInput {
  readonly intakeId: string
  readonly bytes: Buffer
  readonly mimeType: string
  readonly tag: AgentTag
  readonly note: string | null
  readonly batch: string | null
}

export interface AgentReplaceResult extends AgentImageResult {
  readonly replaced: boolean
  readonly versionNo: number | null
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/**
 * D145: a redo's render replaces the image on the intake it was requested for: a new generated
 * version under versions/<intake>/v<n>, selected, and every draft showing the old version now shows it.
 */
export async function replaceAgentImage(input: AgentReplaceInput): Promise<AgentReplaceResult> {
  if (input.bytes.byteLength === 0) throw new ConsoleError('The file is empty.', null, false)
  if (input.bytes.byteLength > AGENT_IMAGE_MAX_BYTES) throw new ConsoleError('The file is larger than 25 MB.', null, false)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const db = supabaseServer()
  const existing = await findDuplicate(sha256)
  if (existing) return { ...existing, replaced: false, versionNo: null }

  const { data: versions, error: versionsError } = await db
    .from('image_versions').select('version_no').eq('intake_file_id', input.intakeId).order('version_no', { ascending: false }).limit(1)
  if (versionsError) throw new ConsoleError('The image versions could not be read.', versionsError.message, true)
  const rows = (versions ?? []) as { version_no: number }[]
  if (rows.length === 0) throw new ConsoleError('That image has no versions to replace.', input.intakeId, false)
  const versionNo = rows[0].version_no + 1  // ponytail: the RPC recomputes max+1; a concurrent replace of one image is not a real case
  const storageKey = `versions/${input.intakeId}/v${versionNo}.${EXT[input.mimeType] ?? 'png'}`
  const thumbKey = `versions/${input.intakeId}/v${versionNo}_thumb.webp`

  const [{ width, height }, thumbnail, phash] = await Promise.all([readImageDimensions(input.bytes), makeThumbnail(input.bytes), perceptualHash(input.bytes)])
  const store = objectStore()
  await store.putImmutable(storageKey, input.bytes, input.mimeType, { source: 'agent-redo', 'intake-file-id': input.intakeId })
  await store.putImmutable(thumbKey, thumbnail, 'image/webp', { source: 'agent-redo', 'intake-file-id': input.intakeId })

  const { data: job } = input.batch ? await db.from('agent_jobs').select('id').eq('label', input.batch).maybeSingle<{ id: string }>() : { data: null }
  const { data, error } = await db.rpc('replace_intake_image_from_agent', {
    p_intake_file_id: input.intakeId, p_storage_key: storageKey, p_thumb_key: thumbKey, p_width: width, p_height: height, p_phash: phash,
    p_actor: AGENT_OPERATOR.email, p_tag: input.tag, p_note: input.note, p_job_id: job?.id ?? null, p_sha256: sha256,
  })
  if (error) throw new ConsoleError('The new image is stored, but the old one could not be replaced.', [error.code, error.message].filter(Boolean).join(' · '), error.code !== '55000' && error.code !== '22023' && error.code !== 'P0002')
  const row = data as { intake_id?: unknown; version_no?: unknown } | null
  if (!row || typeof row.intake_id !== 'string') throw new ConsoleError('The database returned no intake id.', null, true)
  return { intakeId: row.intake_id, status: 'enhanced', duplicate: false, replaced: true, versionNo: typeof row.version_no === 'number' ? row.version_no : versionNo }
}

export interface AgentBatchRow {
  readonly intake_id: string
  readonly filename: string
  readonly tag: AgentTag | null
  readonly note: string | null
  readonly restock_sku: string | null
  readonly status: string
  readonly draft_id: string | null
  readonly created_at: string
}

export async function listAgentBatch(batch: string): Promise<readonly AgentBatchRow[]> {
  const { data, error } = await supabaseServer()
    .from('intake_files')
    .select('id, filename, agent_tag, agent_note, restock_sku, status, product_draft_id, discovered_at')
    .eq('agent_batch', batch)
    .order('discovered_at', { ascending: true })
    .limit(500)
  if (error) throw new ConsoleError('The batch could not be listed.', error.message, true)
  return ((data ?? []) as {
    id: string; filename: string; agent_tag: AgentTag | null; agent_note: string | null
    restock_sku: string | null; status: string; product_draft_id: string | null; discovered_at: string
  }[]).map((r) => ({
    intake_id: r.id, filename: r.filename, tag: r.agent_tag, note: r.agent_note, restock_sku: r.restock_sku,
    status: r.status, draft_id: r.product_draft_id, created_at: r.discovered_at,
  }))
}

/** The operator's click: this draft replaces `sku`, archive it on publish (or withdraw that). */
export async function setAgentSupersession(operator: Operator, draftId: string, sku: string, enable: boolean): Promise<void> {
  const { error } = await supabaseServer().rpc('set_agent_supersession', {
    p_draft_id: draftId, p_sku: sku, p_enable: enable, p_actor: operator.email,
  })
  if (error) throw new ConsoleError(error.hint?.trim() || 'The old listing could not be marked.', [error.code, error.message].filter(Boolean).join(' · '), error.code === '55000')
}
