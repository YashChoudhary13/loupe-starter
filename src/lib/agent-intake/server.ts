import 'server-only'

import { createHash } from 'node:crypto'

import type { Operator } from '@/lib/auth/authorize'
import { ConsoleError } from '@/lib/console/mutations'
import type { AgentSuggest, AgentTag } from '@/lib/console/types'
import { R2ObjectStore } from '@/lib/enhance/storage'
import { serverEnv } from '@/lib/env'
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
}

export interface AgentImageResult {
  readonly intakeId: string
  readonly status: string
  readonly duplicate: boolean
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

  const { data: existing, error: lookupError } = await db
    .from('intake_files')
    .select('id, status')
    .eq('agent_sha256', sha256)
    .limit(1)
    .maybeSingle<{ id: string; status: string }>()
  if (lookupError) throw new ConsoleError('The duplicate check failed.', lookupError.message, true)
  if (existing) return { intakeId: existing.id, status: existing.status, duplicate: true }

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

  const store = new R2ObjectStore({
    endpoint: serverEnv.r2Endpoint,
    accessKeyId: serverEnv.r2AccessKeyId,
    secretAccessKey: serverEnv.r2SecretAccessKey,
    bucket: serverEnv.r2Bucket,
  })
  await store.putImmutable(upload.storage_key, input.bytes, input.mimeType, { 'manual-upload-id': ticket.uploadId, source: 'agent-image' })

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
  return parsed(data)
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
