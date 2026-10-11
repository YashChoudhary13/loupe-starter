import 'server-only'

import { randomUUID } from 'node:crypto'

import { jobLabel, parseJobLabel } from '@/lib/agent-jobs/label'
import type { Operator } from '@/lib/auth/authorize'
import { consoleObjectStore, signKeys } from '@/lib/console/images'
import { ConsoleError } from '@/lib/console/mutations'
import type { SignedImage } from '@/lib/console/types'
import { makeThumbnail } from '@/lib/images/image'
import { supabaseServer } from '@/lib/supabase/server'

import { AGENT_IMAGE_MAX_BYTES, AGENT_OPERATOR, findSourcePhoto, ingestAgentImage } from './server'
import { restockChoice, restockPayloadFromRow, type RestockCandidate, type RestockPayload } from './suggest'

/**
 * D148: restocks wait for the owner. Claude posts a phone photograph it believes (or suspects) is a
 * piece the shop already sells, with the old listings beside it; nothing is rendered and nothing
 * reaches Pending until an operator picks one of three in the Restock section.
 */

const PHOTO_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }
const OLD_IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const thumbKeyOf = (storageKey: string) => `${storageKey}.thumb.webp`

/** The listing's own filename, so a descriptive name stays descriptive on the new listing. */
function listingFilename(url: string, sku: string, ext: string): string {
  let stem = ''
  try { stem = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') } catch { /* the SKU names it instead */ }
  stem = stem.replace(/\.[^.]+$/u, '').replace(/[/\\\u0000-\u001f\u007f]/gu, '-').trim()
  return `${(stem || sku).slice(0, 200)}.${ext}`
}

function rpcError(message: string, error: { code?: string; message: string; hint?: string | null }): ConsoleError {
  return new ConsoleError(error.hint?.trim() || message, [error.code, error.message].filter(Boolean).join(' · '), error.code !== '55000' && error.code !== '22023' && error.code !== 'P0002')
}

/** The phone photographs Loupe already holds for a batch label; empty when the label is no batch. */
export async function listBatchPhotos(batch: string): Promise<readonly string[]> {
  const db = supabaseServer()
  const { data: job } = await db.from('agent_jobs').select('id').eq('label', batch).maybeSingle<{ id: string }>()
  if (!job) return []
  const { data, error } = await db.from('agent_job_photos').select('filename').eq('job_id', job.id).eq('status', 'uploaded').limit(1000)
  if (error) throw new ConsoleError('The batch photographs could not be listed.', error.message, true)
  return ((data ?? []) as { filename: string }[]).map((p) => p.filename)
}

/** A photograph Claude was given outside Loupe joins a finished batch of that label, so everything downstream can name it. */
export async function registerAgentPhoto(input: { batch: string; filename: string; mimeType: string; bytes: Buffer }): Promise<{ photoId: string; duplicate: boolean }> {
  const label = parseJobLabel(input.batch)
  const filename = input.filename.trim()
  if (!filename || filename.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(filename)) throw new ConsoleError('That filename cannot be used.', null, false)
  const ext = PHOTO_EXT[input.mimeType]
  if (!ext) throw new ConsoleError('Photos must be JPEG, PNG, WebP or HEIC.', `Received ${input.mimeType || '(missing)'}`, false)
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > AGENT_IMAGE_MAX_BYTES) throw new ConsoleError('That photo is empty or larger than 25 MB.', null, false)
  const known = await findSourcePhoto(label, filename)
  if (known) return { photoId: known, duplicate: true }
  const photoId = randomUUID()
  const key = `intake/direct/${photoId}.${ext}`
  await consoleObjectStore().putImmutable(key, input.bytes, input.mimeType, { source: 'agent-photo' })
  const { data, error } = await supabaseServer().rpc('agent_register_photo', {
    p_label: label, p_photo_id: photoId, p_storage_key: key, p_filename: filename, p_bytes: input.bytes.byteLength, p_actor: AGENT_OPERATOR.email,
  })
  if (error) throw rpcError('The photograph is stored, but it could not be recorded.', error)
  const row = data as { photo_id?: unknown; duplicate?: unknown } | null
  if (!row || typeof row.photo_id !== 'string') throw new ConsoleError('The database returned no photo id.', null, true)
  return { photoId: row.photo_id, duplicate: row.duplicate === true }
}

/** Claude's post: this phone photograph is (or may be) a restock of these listings. Returns the state it is in afterwards. */
export async function postRestockCandidate(batch: string, sourceFilename: string, payload: RestockPayload): Promise<{ photoId: string; state: string }> {
  const photoId = await findSourcePhoto(batch, sourceFilename)
  if (!photoId) throw new ConsoleError(`Loupe holds no photograph called ${sourceFilename} in batch ${batch}. Register it first (POST /api/agent/photos).`, null, false)
  const db = supabaseServer()
  const { data: photo, error: readError } = await db.from('agent_job_photos').select('storage_key, restock_state').eq('id', photoId)
    .maybeSingle<{ storage_key: string; restock_state: string | null }>()
  if (readError || !photo) throw new ConsoleError('The photograph could not be read back.', readError?.message ?? null, true)
  if (photo.restock_state === null) {
    // A 512 px copy for the card, made once here so the operator's page never loads phone originals.
    // Best effort: without it the card shows the photograph itself (a HEIC cannot be decoded here).
    try {
      const store = consoleObjectStore()
      await store.putImmutable(thumbKeyOf(photo.storage_key), await makeThumbnail(await store.get(photo.storage_key)), 'image/webp', { source: 'agent-photo-thumb' })
    } catch (cause) {
      console.error('restock candidate thumbnail failed:', cause instanceof Error ? cause.message : String(cause))
    }
  }
  const { data, error } = await db.rpc('post_restock_candidate', { p_photo_id: photoId, p_restock: payload, p_actor: AGENT_OPERATOR.email })
  if (error) throw rpcError('The restock candidate could not be recorded.', error)
  return { photoId, state: typeof data === 'string' ? data : 'pending' }
}

export interface RestockCandidateItem {
  readonly photoId: string
  readonly filename: string
  readonly batch: string
  readonly postedAt: string
  readonly kind: RestockPayload['kind']
  readonly note: string | null
  /** The small copy when it exists, and the photograph itself to fall back on and to open full size. */
  readonly thumb: SignedImage | null
  readonly photo: SignedImage | null
  readonly candidates: readonly RestockCandidate[]
}

interface CandidateRow {
  id: string; filename: string; storage_key: string; restock: unknown; created_at: string
  agent_jobs: { label: string } | null
}

export async function loadRestockCandidates(): Promise<readonly RestockCandidateItem[]> {
  const { data, error } = await supabaseServer()
    .from('agent_job_photos')
    .select('id, filename, storage_key, restock, created_at, agent_jobs ( label )')
    .eq('restock_state', 'pending')
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) throw new Error(`restock candidates: ${error.message}`)
  const rows = (data ?? []) as unknown as CandidateRow[]
  const signed = await signKeys(rows.flatMap((r) => [r.storage_key, thumbKeyOf(r.storage_key)]))
  return rows.flatMap((r): RestockCandidateItem[] => {
    const payload = restockPayloadFromRow(r.restock)
    if (!payload) return []
    return [{
      photoId: r.id, filename: r.filename, batch: r.agent_jobs?.label ?? '', postedAt: r.created_at, kind: payload.kind, note: payload.note,
      thumb: signed.get(thumbKeyOf(r.storage_key)) ?? null, photo: signed.get(r.storage_key) ?? null, candidates: payload.candidates,
    }]
  })
}

/** One cheap count for the sidebar badge (partial index on the pending rows). */
export async function countRestockCandidates(): Promise<number> {
  const { count, error } = await supabaseServer().from('agent_job_photos').select('id', { count: 'exact', head: true }).eq('restock_state', 'pending')
  if (error) {
    console.error('restock candidate count failed:', error.message)
    return 0
  }
  return count ?? 0
}

export type RestockDecision = 'use_old' | 'generate' | 'wrong'

/**
 * The operator's click. use_old: the chosen listing's image goes to Pending as a Restock row, now.
 * generate / wrong: one render job for the runner. Either way the candidate leaves the section.
 */
export async function decideRestockCandidate(
  operator: Operator,
  input: { photoId: string; choice: RestockDecision; sku: string | null },
): Promise<void> {
  const db = supabaseServer()
  const { data: row, error } = await db.from('agent_job_photos').select('id, filename, restock, restock_state, agent_jobs ( label )').eq('id', input.photoId)
    .maybeSingle<{ id: string; filename: string; restock: unknown; restock_state: string | null; agent_jobs: { label: string } | null }>()
  if (error) throw new ConsoleError('The photograph could not be read.', error.message, true)
  const payload = row ? restockPayloadFromRow(row.restock) : null
  if (!row || !payload || row.restock_state !== 'pending') throw new ConsoleError('That photograph was already decided. Reload Restock.', null, false)

  const choice = input.choice === 'wrong' ? null : restockChoice(payload, input.sku ?? '')
  if (input.choice !== 'wrong' && !choice) throw new ConsoleError('Pick which listing this piece is.', null, false)

  if (input.choice === 'use_old' && choice) {
    const { chosen, alsoArchive, note } = choice
    if (!chosen.imageUrl) throw new ConsoleError(`${chosen.sku} has no listing image to reuse. Choose "Generate new image".`, null, false)
    // No image/webp in Accept: Shopify's CDN then serves the file as it was uploaded instead of a re-encoded copy.
    const response = await fetch(chosen.imageUrl, { headers: { accept: 'image/png,image/jpeg,*/*;q=0.1' }, signal: AbortSignal.timeout(30_000) })
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!response.ok || !(mimeType in OLD_IMAGE_EXT)) {
      throw new ConsoleError(`The listing image of ${chosen.sku} could not be fetched from Shopify.`, `HTTP ${response.status} ${mimeType}`, true)
    }
    // Idempotent on this photograph: a second click lands on the same Pending row.
    await ingestAgentImage({
      bytes: Buffer.from(await response.arrayBuffer()),
      filename: listingFilename(chosen.imageUrl, chosen.sku, OLD_IMAGE_EXT[mimeType]),
      mimeType,
      tag: 'restock',
      note: note || null,
      restockSku: chosen.sku,
      suggest: chosen.suggest ? { ...chosen.suggest, alsoArchive } : null,
      batch: row.agent_jobs?.label ?? null,
      sourceFilename: row.filename,
      sourcePhotoId: row.id,
      dedupeSalt: `restock:${row.id}`,
    })
  }

  const { error: decideError } = await db.rpc('decide_restock_candidate', {
    p_photo_id: row.id,
    p_state: input.choice,
    p_sku: choice?.chosen.sku ?? null,
    p_restock: input.choice === 'generate' && choice
      ? { sku: choice.chosen.sku, handle: choice.chosen.handle, also: choice.others.map((c) => c.handle), also_archive: choice.alsoArchive }
      : null,
    p_instructions: input.choice === 'generate' && choice
      ? `Approved restock of ${choice.chosen.sku} (${choice.chosen.handle}): the owner wants a new image of it. Render this photograph.`
      : input.choice === 'wrong' ? 'The owner says this is not a restock. Treat it as a new piece.' : null,
    // ponytail: one job per click, worked one after another by the runner (about 4 minutes each); collect clicks into one job if that queue ever gets long.
    p_label: input.choice === 'use_old' ? null : jobLabel(input.choice === 'generate' ? 'restock' : 'new', row.filename, new Date()),
    p_actor: operator.email,
  })
  if (decideError) throw rpcError('The choice could not be recorded.', decideError)
}

/** `orig` in the console: the phone photograph an agent image was rendered from, signed only when asked for. */
export async function phonePhotoUrl(intakeFileId: string): Promise<SignedImage> {
  const db = supabaseServer()
  const { data: file } = await db.from('intake_files').select('agent_source_photo_id').eq('id', intakeFileId).maybeSingle<{ agent_source_photo_id: string | null }>()
  const { data: photo } = file?.agent_source_photo_id
    ? await db.from('agent_job_photos').select('storage_key').eq('id', file.agent_source_photo_id).maybeSingle<{ storage_key: string }>()
    : { data: null }
  const signed = photo ? (await signKeys([photo.storage_key])).get(photo.storage_key) : null
  if (!signed) throw new ConsoleError('Loupe does not hold the phone photograph for this image.', null, false)
  return signed
}
