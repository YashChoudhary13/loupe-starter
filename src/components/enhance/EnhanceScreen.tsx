'use client'

import { Check } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { beginJobPhotoUploadAction, createJobAction, finishJobPhotoUploadAction, listJobsAction, queueJobAction } from '@/app/(shell)/enhance/actions'
import { defaultJobLabel, queueIsStale } from '@/lib/agent-jobs/label'
import { photoSignature, pickPhotos } from '@/lib/agent-jobs/photos'
import type { JobSummary } from '@/lib/agent-jobs/server'
import { cn } from '@/lib/utils'

import { Card, Notice, SectionLabel } from '../console/primitives'
import { putUploadedObject } from '../upload/put-object'
import { shrinkPhoto } from './shrink-photo'

type FileState = 'waiting' | 'preparing' | 'uploading' | 'verifying' | 'uploaded' | 'failed'
interface PhotoItem { key: string; sig: string; file: File; previewUrl: string; progress: number; state: FileState; detail: string | null }
interface Said { text: string; tone: 'info' | 'error'; stale: boolean }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
// Measured on the Canada runner, 2026-10-10: 1 photo took 12 minutes, 15 photos took 26. About ten minutes of fixed work plus one per photo.
const eta = (photos: number) => `about ${10 + photos} minutes`

// DESIGN.md: everything interactive is a pill; black is the one primary action, grey is available.
const big = 'flex h-12 w-full items-center justify-center rounded-pill px-5 text-[14px] font-medium transition-colors disabled:opacity-45'
const small = 'shrink-0 rounded-pill bg-chip px-3.5 py-[7px] text-[11.5px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-45'

/** A page opened before a deploy calls Server Actions that no longer exist; Next throws instead of answering. */
function explain(cause: unknown): Said {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (/server action|older or newer deployment/i.test(text)) return { text: 'Loupe was updated while this page was open. Reload it, then add the photos again.', tone: 'error', stale: true }
  if (/failed to fetch|networkerror|load failed/i.test(text)) return { text: 'Loupe could not be reached. Check the connection and try again.', tone: 'error', stale: false }
  return { text, tone: 'error', stale: false }
}

function tileText(p: PhotoItem): string {
  if (p.state === 'waiting') return 'Waiting'
  if (p.state === 'preparing') return 'Preparing'
  // The bar counts bytes handed to the network; storage confirms a moment later.
  return p.state === 'uploading' && p.progress < 99 ? `${p.progress}%` : 'Finishing'
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
  const [said, setSaid] = useState<Said | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => new Date())

  const refresh = useCallback(async () => {
    try {
      const result = await listJobsAction()
      if (result.ok) setJobs(result.data)
      setNow(new Date())
    } catch (cause) {
      const why = explain(cause)
      if (why.stale) setSaid(why)
    }
  }, [])

  // A queued or running batch changes without us; poll while one exists.
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => { void refresh() }, 15_000)
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
      patch(item.key, { state: 'preparing', progress: 0, detail: null })
      const file = await shrinkPhoto(item.file)
      patch(item.key, { state: 'uploading' })
      const ticket = await beginJobPhotoUploadAction({ jobId, filename: file.name, mimeType: file.type || 'image/jpeg', bytes: file.size })
      if (!ticket.ok) { patch(item.key, { state: 'failed', detail: ticket.error.message }); return }
      await putUploadedObject(ticket.data.uploadUrl, file, ticket.data.contentType, (percent) => patch(item.key, { progress: percent }))
      patch(item.key, { state: 'verifying' })
      const done = await finishJobPhotoUploadAction(ticket.data.photoId)
      if (!done.ok) { patch(item.key, { state: 'failed', detail: done.error.message }); return }
      patch(item.key, { state: 'uploaded', progress: 100 })
      setUploaded(done.data.photoCount)
    } catch (cause) {
      const why = explain(cause)
      patch(item.key, { state: 'failed', detail: why.text })
      if (why.stale) setSaid(why)
    }
  }, [patch])

  /** Creates the batch on first use, then uploads three at a time. A failure before any upload marks every tile. */
  const upload = useCallback(async (items: readonly PhotoItem[]) => {
    setBusy(true)
    setSaid((s) => (s && s.tone === 'error' && !s.stale ? null : s)) // a fresh attempt clears an old error; a stale page stays stale
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
      setSaid(why)
    } finally {
      setBusy(false)
    }
  }, [ensureJob, uploadOne])

  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return
    const { fresh, skipped, repeats } = pickPhotos(files, new Set(photos.filter((p) => p.state !== 'failed').map((p) => p.sig)))
    const lines = [
      skipped > 0 ? `${plural(skipped, 'file')} skipped: only JPEG, PNG, WebP or HEIC photos.` : null,
      repeats > 0 ? `${plural(repeats, 'photo')} already in this batch, not added again.` : null,
    ].filter((line): line is string => line !== null)
    setSaid(lines.length > 0 ? { text: lines.join(' '), tone: 'info', stale: false } : null)
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
      if (!result.ok) { setSaid({ text: result.error.message, tone: 'error', stale: false }); return }
      setJobs(result.data)
      setNow(new Date())
      setSaid({ text: `Sent ${plural(uploaded, 'photo')} to Claude. Finished images appear in the Console in ${eta(uploaded)}.`, tone: 'info', stale: false })
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setJob(null); setPhotos([]); setUploaded(0); setLabel(defaultJobLabel(new Date()))
    } catch (cause) {
      setSaid(explain(cause))
    } finally {
      setBusy(false)
    }
  }, [job, photos, uploaded])

  /** A batch left at Collecting (page closed, upload interrupted) is picked up again from the list. */
  const resume = useCallback((j: JobSummary) => {
    for (const p of photos) URL.revokeObjectURL(p.previewUrl)
    setJob(j); setLabel(j.label); setUploaded(j.photoCount); setPhotos([]); setSaid(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [photos])

  const failed = photos.filter((p) => p.state === 'failed')
  const landed = photos.filter((p) => p.state === 'uploaded').length
  const started = job !== null || photos.length > 0

  return (
    <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
      <div className="mx-auto flex w-full max-w-[620px] flex-col gap-3.5">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Enhance</h1>
          <p className="mt-1 text-[13px] text-ink-soft">Photograph new stock and send it to Claude. Finished images land in the Console, tagged Ready, Needs review or Restock.</p>
        </div>

        {said && (
          <Notice tone={said.tone === 'error' ? 'attention' : 'plain'} title={said.text}>
            {said.stale
              ? <button type="button" onClick={() => window.location.reload()} className="mt-1 rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white">Reload</button>
              : <button type="button" onClick={() => setSaid(null)} className="text-[11.5px] underline underline-offset-2">Dismiss</button>}
          </Notice>
        )}

        <Card className="p-4 md:p-5">
          <div className="flex items-baseline justify-between gap-3">
            <SectionLabel>{job ? 'Batch' : 'New batch'}</SectionLabel>
            {job && <span className="truncate text-[12px] text-muted-foreground">{job.label}</span>}
          </div>
          {!job && (
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} aria-label="Batch label"
              ref={(el) => { if (el && !el.value && !label) { const v = defaultJobLabel(new Date()); el.value = v; setLabel(v) } }}
              className="mt-2 h-11 w-full rounded-field bg-chip px-3.5 text-[14px] text-ink focus:outline-2 focus:outline-ink" />
          )}

          {photos.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <li key={p.key} className="relative aspect-square overflow-hidden rounded-tile bg-chip">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.previewUrl} alt={p.file.name} className={cn('size-full object-cover transition-opacity', p.state !== 'uploaded' && 'opacity-55')} />
                  {p.state === 'uploaded' && (
                    <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-ink text-white" aria-label="Uploaded"><Check className="size-3" strokeWidth={3} /></span>
                  )}
                  {p.state === 'failed' && (
                    <button type="button" disabled={busy} onClick={() => void upload([p])} title={p.detail ?? undefined} aria-label={`Retry ${p.file.name}`}
                      className="absolute inset-0 flex items-end p-1.5 text-left">
                      <span className="rounded-pill bg-[#faf4e9] px-2.5 py-1 text-[10.5px] font-medium text-amber">Failed · tap to retry</span>
                    </button>
                  )}
                  {p.state !== 'uploaded' && p.state !== 'failed' && (
                    <>
                      <span className="absolute bottom-3 left-1.5 rounded-pill bg-white px-2.5 py-1 text-[10.5px] font-medium text-ink">{tileText(p)}</span>
                      <span className="absolute inset-x-0 bottom-0 h-1 bg-white/60"><span className="block h-full bg-ink transition-[width]" style={{ width: `${p.progress}%` }} /></span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {photos.length > 0 && (
            <p className="mt-2 text-[12px] text-muted-foreground">
              {landed} of {photos.length} uploaded
              {failed.length > 0 && <span className="text-amber"> · {failed.length} failed{failed[0]?.detail ? `: ${failed[0].detail}` : ''}</span>}
            </p>
          )}
          {job && photos.length === 0 && <p className="mt-2 text-[12px] text-muted-foreground">{plural(uploaded, 'photo')} already in this batch.</p>}

          {/* The FileList is live: resetting the input empties it, so the files are copied out first. */}
          <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; addFiles(files) }} />
          <div className="mt-3.5 flex flex-col gap-2">
            <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
              className={cn(big, uploaded > 0 ? 'bg-chip text-ink-soft' : 'bg-ink text-white')}>
              {busy && photos.length > 0 ? `Uploading ${Math.min(landed + 1, photos.length)} of ${photos.length}` : started ? 'Add more photos' : 'Add photos'}
            </button>
            {started && (
              <button type="button" onClick={() => void send()} disabled={!job || uploaded === 0 || busy} className={cn(big, 'bg-ink text-white')}>
                Send to Claude{uploaded > 0 ? ` · ${plural(uploaded, 'photo')}` : ''}
              </button>
            )}
          </div>
        </Card>

        <div className="mt-2 flex items-center justify-between">
          <SectionLabel>Batches</SectionLabel>
          <button type="button" className={small} onClick={() => void refresh()}>Refresh</button>
        </div>
        <div className="flex flex-col gap-2 pb-10">
          {jobs.length === 0 && <p className="rounded-panel bg-surface p-4 text-[12.5px] text-muted-foreground">No batches yet.</p>}
          {jobs.map((j) => (
            <article key={j.id} className="rounded-panel bg-surface p-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] font-medium">
                  {j.label}
                  {j.kind === 'redo' && <span className="ml-2 rounded-pill bg-chip px-2 py-0.5 text-[10px] font-normal text-muted-foreground">redo</span>}
                </span>
                <Status job={j} now={now} />
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
                <span>
                  {plural(job?.id === j.id ? uploaded : j.photoCount, 'photo')}
                  {j.status === 'done' && ` · ${plural(j.resultCount, 'final')} in the Console`}
                </span>
                {j.status === 'done' && j.resultCount > 0 && <Link href="/console" className={small}>Open Console</Link>}
                {j.status === 'collecting' && j.kind === 'batch' && (job?.id === j.id
                  ? <span className="text-[11.5px]">open above</span>
                  : <button type="button" disabled={busy} onClick={() => resume(j)} className={small}>Continue</button>)}
              </div>
              {j.kind === 'redo' && j.instructions && <p className="mt-1.5 text-[12px] text-ink-soft">“{j.instructions}”</p>}
              {j.status === 'running' && <p className="mt-1.5 text-[12px] text-ink-soft">Claude is matching, rendering and checking. {plural(j.photoCount, 'photo')} take{j.photoCount === 1 ? 's' : ''} {eta(j.photoCount)}, then the images appear in the Console.</p>}
              {j.status === 'queued' && (queueIsStale(j.queuedAt, now)
                ? <p className="mt-1.5 text-[12px] text-amber">Nothing has picked this up yet.</p>
                : <p className="mt-1.5 text-[12px] text-ink-soft">Waiting for Claude, usually under a minute.</p>)}
              {j.note && <p className="mt-1.5 line-clamp-6 whitespace-pre-line text-[12px] text-ink-soft">{j.note}</p>}
              {j.error && <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-[12px] text-amber">{j.error}</p>}
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

/** Tracking's status pill: black while it runs, amber when a human is needed, grey otherwise. */
function Status({ job, now }: { job: JobSummary; now: Date }) {
  const since = job.startedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(job.startedAt)) / 60_000)) : 0
  const text = job.status === 'running' ? `Running · ${since} min` : job.status
  return (
    <span className={cn('shrink-0 rounded-pill px-2.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em]',
      job.status === 'failed' ? 'bg-[#faf2e4] text-amber' : job.status === 'running' ? 'bg-ink text-white' : 'bg-chip text-muted-foreground')}>
      {text}
    </span>
  )
}
