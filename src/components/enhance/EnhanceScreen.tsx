'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { beginJobPhotoUploadAction, createJobAction, finishJobPhotoUploadAction, listJobsAction, queueJobAction } from '@/app/(shell)/enhance/actions'
import { defaultJobLabel, queueIsStale } from '@/lib/agent-jobs/label'
import { photoSignature, pickPhotos } from '@/lib/agent-jobs/photos'
import type { JobSummary } from '@/lib/agent-jobs/server'
import { cn } from '@/lib/utils'

import { putUploadedObject } from '../upload/put-object'

type FileState = 'waiting' | 'uploading' | 'verifying' | 'uploaded' | 'failed'
interface PhotoItem { key: string; sig: string; file: File; previewUrl: string; progress: number; state: FileState; detail: string | null }
interface Notice { text: string; tone: 'info' | 'error'; stale: boolean }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A page opened before a deploy calls Server Actions that no longer exist; Next throws instead of answering. */
function explain(cause: unknown): Notice {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (/server action|older or newer deployment/i.test(text)) return { text: 'Loupe was updated while this page was open. Reload it, then add the photos again.', tone: 'error', stale: true }
  if (/failed to fetch|networkerror|load failed/i.test(text)) return { text: 'Loupe could not be reached. Check the connection and try again.', tone: 'error', stale: false }
  return { text, tone: 'error', stale: false }
}

/**
 * D143 — the phone's way in. Pick photos (camera or gallery), they go straight to
 * private storage, then one tap sends the batch to the enhancer. Every step answers on
 * screen: a tile per photo the moment it is picked, its progress, and why it failed.
 */
export function EnhanceScreen({ initialJobs }: { initialJobs: readonly JobSummary[] }) {
  const [jobs, setJobs] = useState(initialJobs)
  // Server and browser clocks differ, so the default label is set in the browser's time zone once the input mounts.
  const [label, setLabel] = useState('')
  const [job, setJob] = useState<JobSummary | null>(null)
  const [photos, setPhotos] = useState<readonly PhotoItem[]>([])
  const [uploaded, setUploaded] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => new Date())

  const refresh = useCallback(async () => {
    try {
      const result = await listJobsAction()
      if (result.ok) setJobs(result.data)
      setNow(new Date())
    } catch (cause) {
      const why = explain(cause)
      if (why.stale) setNotice(why)
    }
  }, [])

  // A queued or running batch changes without us; poll gently while one exists.
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => { void refresh() }, 30_000)
    return () => window.clearInterval(timer)
  }, [active, refresh])

  const patch = useCallback((key: string, change: Partial<PhotoItem>) => {
    setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, ...change } : p)))
  }, [])

  const ensureJob = useCallback(async (): Promise<JobSummary> => {
    if (job) return job
    const result = await createJobAction(label)
    if (!result.ok) throw new Error(result.error.message)
    setJob(result.data)
    setJobs((prev) => [result.data, ...prev])
    return result.data
  }, [job, label])

  const uploadOne = useCallback(async (item: PhotoItem, jobId: string) => {
    try {
      patch(item.key, { state: 'uploading', progress: 0, detail: null })
      const ticket = await beginJobPhotoUploadAction({ jobId, filename: item.file.name, mimeType: item.file.type || 'image/jpeg', bytes: item.file.size })
      if (!ticket.ok) { patch(item.key, { state: 'failed', detail: ticket.error.message }); return }
      await putUploadedObject(ticket.data.uploadUrl, item.file, ticket.data.contentType, (percent) => patch(item.key, { progress: percent }))
      patch(item.key, { state: 'verifying' })
      const done = await finishJobPhotoUploadAction(ticket.data.photoId)
      if (!done.ok) { patch(item.key, { state: 'failed', detail: done.error.message }); return }
      patch(item.key, { state: 'uploaded', progress: 100 })
      setUploaded(done.data.photoCount)
    } catch (cause) {
      const why = explain(cause)
      patch(item.key, { state: 'failed', detail: why.text })
      if (why.stale) setNotice(why)
    }
  }, [patch])

  /** Creates the batch on first use, then uploads three at a time. A failure before any upload marks every tile. */
  const upload = useCallback(async (items: readonly PhotoItem[]) => {
    setBusy(true)
    setNotice((n) => (n && n.tone === 'error' && !n.stale ? null : n)) // a fresh attempt clears an old error; a stale page stays stale
    try {
      const current = await ensureJob()
      const queue = [...items]
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) await uploadOne(item, current.id)
      }))
    } catch (cause) {
      const why = explain(cause)
      const keys = new Set(items.map((i) => i.key))
      setPhotos((prev) => prev.map((p) => (keys.has(p.key) && p.state !== 'uploaded' ? { ...p, state: 'failed', detail: why.text } : p)))
      setNotice(why)
    } finally {
      setBusy(false)
    }
  }, [ensureJob, uploadOne])

  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return
    const { fresh, skipped, repeats } = pickPhotos(files, new Set(photos.filter((p) => p.state !== 'failed').map((p) => p.sig)))
    const said = [
      skipped > 0 ? `${plural(skipped, 'file')} skipped: only JPEG, PNG, WebP or HEIC photos.` : null,
      repeats > 0 ? `${plural(repeats, 'photo')} already in this batch, not added again.` : null,
    ].filter((line): line is string => line !== null)
    setNotice(said.length > 0 ? { text: said.join(' '), tone: 'info', stale: false } : null)
    if (fresh.length === 0) return
    const items: PhotoItem[] = fresh.map((file) => ({
      key: `${photoSignature(file)}|${Math.random().toString(36).slice(2, 8)}`, sig: photoSignature(file), file,
      previewUrl: URL.createObjectURL(file), progress: 0, state: 'waiting', detail: null,
    }))
    const again = new Set(items.map((i) => i.sig))
    // The tiles appear before anything is sent; picking a failed photo again replaces its tile.
    setPhotos((prev) => [...prev.filter((p) => !(p.state === 'failed' && again.has(p.sig))), ...items])
    void upload(items)
  }, [photos, upload])

  const send = useCallback(async () => {
    if (!job) return
    setBusy(true)
    try {
      const result = await queueJobAction(job.id)
      if (!result.ok) { setNotice({ text: result.error.message, tone: 'error', stale: false }); return }
      setJobs(result.data)
      setNotice({ text: `Sent: ${job.label}, ${plural(uploaded, 'photo')}. The enhancer picks it up within two minutes; finals appear in the Console.`, tone: 'info', stale: false })
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setJob(null); setPhotos([]); setUploaded(0); setLabel(defaultJobLabel(new Date()))
    } catch (cause) {
      setNotice(explain(cause))
    } finally {
      setBusy(false)
    }
  }, [job, photos, uploaded])

  /** A batch left at Collecting (page closed, upload interrupted) is picked up again from the list. */
  const resume = useCallback((j: JobSummary) => {
    for (const p of photos) URL.revokeObjectURL(p.previewUrl)
    setJob(j); setLabel(j.label); setUploaded(j.photoCount); setPhotos([]); setNotice(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [photos])

  const failed = photos.filter((p) => p.state === 'failed')
  const landed = photos.filter((p) => p.state === 'uploaded').length

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-24">
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <h1 className="text-lg font-semibold">{job ? `Batch ${job.label}` : 'New batch'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {job ? `${plural(uploaded, 'photo')} uploaded so far. Add more, or send it.` : 'Photos go straight to the enhancer. Finals appear in the Console with a tag.'}
        </p>
        {notice && (
          <div role="status" className={cn('mt-3 flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-sm',
            notice.tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900')}>
            <span>{notice.text}</span>
            {notice.stale
              ? <button type="button" onClick={() => window.location.reload()} className="shrink-0 rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white">Reload</button>
              : <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 px-1 text-base leading-none opacity-60">×</button>}
          </div>
        )}
        {!job && (
          <label className="mt-4 block text-sm font-medium">
            Batch label
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80}
              ref={(el) => { if (el && !el.value && !label) { const v = defaultJobLabel(new Date()); el.value = v; setLabel(v) } }}
              className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-3 text-base" />
          </label>
        )}
        {/* The FileList is live: resetting the input empties it, so the files are copied out first. */}
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; addFiles(files) }} />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
          className="mt-4 w-full rounded-xl bg-primary px-4 py-4 text-base font-semibold text-primary-foreground disabled:opacity-60">
          {busy && photos.length > 0 ? `Uploading ${landed} of ${photos.length}…` : photos.length === 0 && uploaded === 0 ? 'Add photos' : 'Add more photos'}
        </button>
        {photos.length > 0 && (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((p) => (
              <li key={p.key} className="relative aspect-square overflow-hidden rounded-xl bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.previewUrl} alt={p.file.name} className={cn('size-full object-cover transition-opacity', p.state !== 'uploaded' && 'opacity-60')} />
                {(p.state === 'uploading' || p.state === 'waiting') && (
                  <span className="absolute inset-x-0 bottom-6 h-1 bg-black/20"><span className="block h-full bg-white transition-[width]" style={{ width: `${p.progress}%` }} /></span>
                )}
                {p.state === 'failed'
                  ? <button type="button" disabled={busy} onClick={() => void upload([p])} title={p.detail ?? undefined}
                      className="absolute inset-x-0 bottom-0 bg-red-600/90 px-1.5 py-1 text-[11px] font-medium text-white">Failed · tap to retry</button>
                  : <span className={cn('absolute inset-x-0 bottom-0 px-1.5 py-1 text-[11px] font-medium text-white', p.state === 'uploaded' ? 'bg-emerald-600/90' : 'bg-black/60')}>
                      {p.state === 'uploaded' ? 'Uploaded ✓' : p.state === 'verifying' ? 'Checking…' : p.state === 'waiting' ? 'Waiting…' : `${p.progress}%`}
                    </span>}
              </li>
            ))}
          </ul>
        )}
        {photos.length > 0 && (
          <p className="mt-2 text-sm text-muted-foreground">
            {landed} of {photos.length} uploaded{failed.length > 0 && <span className="text-red-600"> · {failed.length} failed{failed[0]?.detail ? `: ${failed[0].detail}` : ''}</span>}
          </p>
        )}
        <button type="button" onClick={() => void send()} disabled={!job || uploaded === 0 || busy}
          className="mt-4 w-full rounded-xl border-2 border-primary px-4 py-4 text-base font-semibold text-primary disabled:opacity-50">
          Send for enhancement{uploaded > 0 ? ` (${plural(uploaded, 'photo')})` : ''}
        </button>
        {uploaded === 0 && !busy && <p className="mt-2 text-center text-xs text-muted-foreground">Add at least one photo to send a batch.</p>}
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Batches</h2>
          <button type="button" className="text-sm text-muted-foreground underline" onClick={() => void refresh()}>Refresh</button>
        </div>
        <ul className="mt-2 divide-y divide-border rounded-2xl border border-border bg-card">
          {jobs.length === 0 && <li className="p-4 text-sm text-muted-foreground">No batches yet.</li>}
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-col gap-1 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">
                  {j.label}
                  {j.kind === 'redo' && <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">redo</span>}
                </span>
                <StatusChip job={j} now={now} />
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  {plural(job?.id === j.id ? uploaded : j.photoCount, 'photo')}
                  {j.status === 'done' && ` · ${plural(j.resultCount, 'final')} in the Console`}
                  {j.runner && ` · ${j.runner}`}
                </span>
                {j.status === 'collecting' && j.kind === 'batch' && (job?.id === j.id
                  ? <span className="text-xs">open above</span>
                  : <button type="button" disabled={busy} onClick={() => resume(j)} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50">Continue</button>)}
              </div>
              {j.kind === 'redo' && j.instructions && <div className="text-sm text-muted-foreground">“{j.instructions}”</div>}
              {j.note && <div className="text-sm">{j.note}</div>}
              {j.error && <div className="text-sm text-red-600">{j.error}</div>}
              {j.status === 'queued' && queueIsStale(j.queuedAt, now) && <div className="text-sm text-amber-700">Nothing has picked this up yet.</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function StatusChip({ job, now }: { job: JobSummary; now: Date }) {
  const since = job.startedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(job.startedAt)) / 60_000)) : 0
  const text = job.status === 'collecting' ? 'Collecting' : job.status === 'queued' ? 'Queued' : job.status === 'running' ? `Running · ${since} min` : job.status === 'done' ? 'Done' : 'Failed'
  const tone = job.status === 'done' ? 'bg-emerald-100 text-emerald-800' : job.status === 'failed' ? 'bg-red-100 text-red-800' : job.status === 'running' ? 'bg-blue-100 text-blue-800' : job.status === 'queued' ? 'bg-amber-100 text-amber-800' : 'bg-muted text-muted-foreground'
  return <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', tone)}>{text}</span>
}
