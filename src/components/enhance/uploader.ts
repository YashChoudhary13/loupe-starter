'use client'

import { useSyncExternalStore } from 'react'

import { photoSignature, pickPhotos, uploadVerdict } from '@/lib/agent-jobs/photos'
import type { JobSummary } from '@/lib/agent-jobs/server'

import { putUploadedObject } from '../upload/put-object'
import { preparePhoto } from './shrink-photo'

/**
 * D179 — the Enhance uploader. It lives in this module, not in the screen, so the photographs keep going up while the
 * operator looks at the Console or any other section; the screen only draws what is here. One run:
 * every photograph is decoded once (upload file + tile thumbnail), four go up side by side, a failure gets two more
 * tries by itself, and when every photograph picked is in storage the batch is sent to Claude without a tap. One
 * photograph that will not go up holds the batch and says so.
 */

export type FileState = 'waiting' | 'preparing' | 'uploading' | 'verifying' | 'uploaded' | 'failed'
export interface PhotoItem {
  readonly key: string; readonly sig: string; readonly name: string; readonly file: File
  readonly thumbUrl: string | null; readonly progress: number; readonly state: FileState; readonly detail: string | null; readonly tries: number
}
export interface Said { readonly text: string; readonly tone: 'info' | 'error'; readonly stale: boolean }
export interface UploadState {
  readonly job: JobSummary | null
  readonly photos: readonly PhotoItem[]
  /** Photographs of this batch in storage, by the server's count. */
  readonly uploaded: number
  readonly busy: boolean
  readonly said: Said | null
  /** The batch list as it stood right after the last send, and when that was; the screen takes both. */
  readonly jobs: readonly JobSummary[] | null
  readonly sentAt: number
}

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: { readonly message: string; readonly retryable: boolean } }

const SIDE_BY_SIDE = 4
const TRIES = 3

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
// The Canada runner splits a batch across up to three parallel sessions (2026-10-10): 6 photos measured at 4 min 10 s.
// Past that the catalogue matcher sets the pace, about 20 s a photo on that host, so roughly two minutes plus a third per photo.
export const eta = (photos: number) => `about ${Math.max(4, Math.round(2 + photos / 3))} minutes`

/** A page opened before a deploy calls Server Actions that no longer exist; Next throws instead of answering. */
export function explain(cause: unknown): Said {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (/server action|older or newer deployment/i.test(text)) return { text: 'Loupe was updated while this page was open. Reload it, then add the photos again.', tone: 'error', stale: true }
  if (/failed to fetch|networkerror|load failed/i.test(text)) return { text: 'Loupe could not be reached. Check the connection and try again.', tone: 'error', stale: false }
  return { text, tone: 'error', stale: false }
}

const EMPTY: UploadState = { job: null, photos: [], uploaded: 0, busy: false, said: null, jobs: null, sentAt: 0 }
let state = EMPTY
const listeners = new Set<() => void>()
const set = (change: Partial<UploadState>) => { state = { ...state, ...change }; for (const l of listeners) l() }
const patch = (key: string, change: Partial<PhotoItem>) => set({ photos: state.photos.map((p) => (p.key === key ? { ...p, ...change } : p)) })
const find = (key: string) => state.photos.find((p) => p.key === key)

export function useUploader(): UploadState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state, () => EMPTY)
}

async function call<T>(op: string, body: Record<string, unknown>): Promise<Result<T>> {
  const response = await fetch('/api/enhance/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...body }) })
  try { return await response.json() as Result<T> } catch {
    return { ok: false, error: { message: response.status === 401 ? 'Your session has ended. Sign in again to continue.' : `Loupe answered ${response.status}. Try again.`, retryable: response.status >= 500 } }
  }
}

// ---------------------------------------------------------------------------------------------
// The run

/** Filenames the batch holds on the server: filled when a batch is picked up again, and as photographs land. */
let names = new Set<string>()
/** Settles once a picked-up batch's filenames are known; a pick waits for it, or the same photographs would go up twice. */
let namesKnown: Promise<void> = Promise.resolve()
let label = ''
const queue: string[] = []
let pumping = false
let lock: { release: () => Promise<void> } | null = null

async function keepAwake() {
  try { lock = await (navigator as Navigator & { wakeLock?: { request: (kind: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null } catch { lock = null }
}

function fail(key: string, message: string, final: boolean) {
  patch(key, { state: 'failed', detail: message, ...(final ? { tries: TRIES } : {}) })
}

async function uploadOne(key: string, jobId: string) {
  const item = find(key)
  if (!item) return
  try {
    patch(key, { state: 'preparing', progress: 0, detail: null, tries: item.tries + 1 })
    const { file, thumb } = await preparePhoto(item.file)
    patch(key, { state: 'uploading', ...(thumb && !item.thumbUrl ? { thumbUrl: URL.createObjectURL(thumb) } : {}) })
    const ticket = await call<{ photoId: string; uploadUrl: string; contentType: string; thumbUploadUrl: string }>('begin', { jobId, filename: file.name, mimeType: file.type || 'image/jpeg', bytes: file.size })
    if (!ticket.ok) { fail(key, ticket.error.message, !ticket.error.retryable); return }
    let shown = 0
    await Promise.all([
      // Every tile redraws on a progress step, so steps of ten: a hundred a second made the page stutter.
      putUploadedObject(ticket.data.uploadUrl, file, ticket.data.contentType, (percent) => { if (percent - shown >= 10 || percent >= 99) { shown = percent; patch(key, { progress: percent }) } }),
      // The thumbnail is for the batch grid. Best effort; the grid shows the filename without it.
      thumb ? putUploadedObject(ticket.data.thumbUploadUrl, new File([thumb], 'thumb.jpg', { type: 'image/jpeg' }), 'image/jpeg', () => undefined).catch(() => undefined) : null,
    ])
    patch(key, { state: 'verifying' })
    const done = await call<{ photoCount: number }>('finish', { photoId: ticket.data.photoId })
    if (!done.ok) { fail(key, done.error.message, !done.error.retryable); return }
    names.add(item.name)
    patch(key, { state: 'uploaded', progress: 100 })
    set({ uploaded: done.data.photoCount })
  } catch (cause) {
    fail(key, explain(cause).text, false)
  }
}

async function pump() {
  if (pumping) return
  pumping = true
  set({ busy: true, said: state.said?.tone === 'error' && !state.said.stale ? null : state.said })
  void keepAwake()
  try {
    let job = state.job
    if (!job) {
      const made = await call<JobSummary>('create', { label })
      if (!made.ok) throw new Error(made.error.message)
      job = made.data
      set({ job })
    }
    const jobId = job.id
    for (;;) {
      await Promise.all(Array.from({ length: SIDE_BY_SIDE }, async () => {
        for (let key = queue.shift(); key; key = queue.shift()) await uploadOne(key, jobId)
      }))
      // A dropped connection fails a handful at once: they go again by themselves, twice, before anyone is asked.
      const again = state.photos.filter((p) => p.state === 'failed' && p.tries < TRIES)
      if (again.length === 0 && queue.length === 0) break
      if (again.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        for (const p of again) { patch(p.key, { state: 'waiting', progress: 0 }); queue.push(p.key) }
      }
    }
  } catch (cause) {
    const why = explain(cause)
    const waiting = new Set(queue.splice(0))
    set({ said: why, photos: state.photos.map((p) => (waiting.has(p.key) || (p.state !== 'uploaded' && p.state !== 'failed') ? { ...p, state: 'failed' as const, detail: why.text } : p)) })
  } finally {
    pumping = false
    void lock?.release().catch(() => undefined)
    lock = null
    set({ busy: false })
  }
  const verdict = uploadVerdict(state.photos.map((p) => p.state))
  if (verdict === 'send') await sendBatch()
  else if (verdict === 'hold' && !state.said?.stale) {
    const failed = state.photos.filter((p) => p.state === 'failed')
    set({ said: { tone: 'error', stale: false, text: `${plural(failed.length, 'photo')} of ${state.photos.length} did not upload, so nothing was sent to Claude yet. ${failed[0]?.detail ?? ''} Tap Retry; the batch sends itself once all are up.` } })
  }
}

function enqueue(keys: readonly string[]) {
  queue.push(...keys)
  void pump()
}

// ---------------------------------------------------------------------------------------------
// What the screen calls

/** Picked files join the batch and start uploading at once. `batchLabel` names a batch that does not exist yet. */
export async function addPhotos(files: readonly File[], batchLabel: string) {
  if (files.length === 0) return
  await namesKnown
  if (!state.job) label = batchLabel
  const { fresh, skipped, repeats } = pickPhotos(files, new Set(state.photos.filter((p) => p.state !== 'failed').map((p) => p.sig)), names)
  const lines = [
    skipped > 0 ? `${plural(skipped, 'file')} skipped: only JPEG, PNG, WebP or HEIC photos.` : null,
    repeats > 0 ? `${plural(repeats, 'photo')} already in this batch, not added again.` : null,
  ].filter((line): line is string => line !== null)
  set({ said: lines.length > 0 ? { text: lines.join(' '), tone: 'info', stale: false } : null })
  if (fresh.length === 0) return
  const items: PhotoItem[] = fresh.map((file) => ({
    key: `${photoSignature(file)}|${Math.random().toString(36).slice(2, 8)}`, sig: photoSignature(file), name: file.name, file,
    thumbUrl: null, progress: 0, state: 'waiting', detail: null, tries: 0,
  }))
  // Picking a failed photo again replaces its tile.
  const again = new Set(items.map((i) => i.sig))
  for (const p of state.photos) if (p.state === 'failed' && again.has(p.sig) && p.thumbUrl) URL.revokeObjectURL(p.thumbUrl)
  set({ photos: [...state.photos.filter((p) => !(p.state === 'failed' && again.has(p.sig))), ...items] })
  enqueue(items.map((i) => i.key))
}

/** The failed photographs go again, with a fresh set of tries. */
export function retryFailed() {
  const failed = state.photos.filter((p) => p.state === 'failed')
  if (failed.length === 0) return
  set({ photos: state.photos.map((p) => (p.state === 'failed' ? { ...p, state: 'waiting' as const, progress: 0, detail: null, tries: 0 } : p)) })
  enqueue(failed.map((p) => p.key))
}

function clear(change: Partial<UploadState>) {
  for (const p of state.photos) if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl)
  names = new Set()
  set({ job: null, photos: [], uploaded: 0, ...change })
}

/** Sends the batch as it stands: by itself when every photograph is up, or by the operator's tap without the failed ones. */
export async function sendBatch() {
  const job = state.job
  if (!job || pumping) return
  set({ busy: true })
  try {
    const result = await call<readonly JobSummary[]>('send', { jobId: job.id })
    if (!result.ok) { set({ said: { text: result.error.message, tone: 'error', stale: false } }); return }
    const count = state.uploaded
    clear({ jobs: result.data, sentAt: Date.now(), said: { text: `Sent ${plural(count, 'photo')} to Claude. Each one shows below as it is done; ${eta(count)} in all.`, tone: 'info', stale: false } })
  } catch (cause) {
    set({ said: explain(cause) })
  } finally {
    set({ busy: false })
  }
}

/** A batch left at Collecting is picked up again: photographs it already holds are skipped when picked again. */
export function resumeBatch(job: JobSummary) {
  if (pumping) return
  clear({ job, uploaded: job.photoCount, said: null })
  namesKnown = call<readonly string[]>('names', { jobId: job.id })
    .then((held) => { if (held.ok && state.job?.id === job.id) names = new Set(held.data) })
    .catch(() => undefined) // without the names a photograph picked again uploads again; nothing is lost
}

export const dismissSaid = () => set({ said: null })

if (typeof window !== 'undefined') {
  // Back on the page, or back on the network: what failed while away goes again without a tap.
  const back = () => { if (!document.hidden && !pumping && state.photos.some((p) => p.state === 'failed')) retryFailed() }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pumping && !lock) void keepAwake(); back() })
  window.addEventListener('online', back)
  // A reload or a closed tab is the one thing that still stops an upload: ask first.
  window.addEventListener('beforeunload', (event) => { if (pumping) event.preventDefault() })
}
