'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { beginJobPhotoUploadAction, createJobAction, finishJobPhotoUploadAction, listJobsAction, queueJobAction } from '@/app/(shell)/enhance/actions'
import { defaultJobLabel, queueIsStale } from '@/lib/agent-jobs/label'
import type { JobSummary } from '@/lib/agent-jobs/server'
import { cn } from '@/lib/utils'

import { putUploadedObject } from '../upload/put-object'

type FileState = 'pending' | 'uploading' | 'verifying' | 'uploaded' | 'failed'
interface PhotoItem { key: string; file: File; previewUrl: string; progress: number; state: FileState; detail: string | null }

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])

/**
 * D143 — the phone's way in. Pick photos (camera or gallery), they go straight to
 * private storage, then one tap sends the batch to the enhancer. The list below shows
 * every batch and where it stands; finals appear in the Console as they land.
 */
export function EnhanceScreen({ initialJobs }: { initialJobs: readonly JobSummary[] }) {
  const [jobs, setJobs] = useState(initialJobs)
  // Server and browser clocks differ, so the default label is set in the browser's time zone once the input mounts.
  const [label, setLabel] = useState('')
  const [job, setJob] = useState<JobSummary | null>(null)
  const [photos, setPhotos] = useState<readonly PhotoItem[]>([])
  const [uploaded, setUploaded] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => new Date())

  // A queued or running batch changes without us; poll gently while one exists.
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(async () => {
      const result = await listJobsAction()
      if (result.ok) setJobs(result.data)
      setNow(new Date())
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [active])

  const patch = useCallback((key: string, change: Partial<PhotoItem>) => {
    setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, ...change } : p)))
  }, [])

  const ensureJob = useCallback(async (): Promise<JobSummary | null> => {
    if (job) return job
    const result = await createJobAction(label)
    if (!result.ok) { setMessage(result.error.message); return null }
    setJob(result.data)
    setJobs((prev) => [result.data, ...prev])
    return result.data
  }, [job, label])

  const addFiles = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return
    const current = await ensureJob()
    if (!current) return
    const items: PhotoItem[] = Array.from(list)
      .filter((file) => ACCEPTED.has(file.type) || /\.(heic|jpe?g|png|webp)$/i.test(file.name))
      .map((file) => ({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`, file, previewUrl: URL.createObjectURL(file), progress: 0, state: 'pending', detail: null }))
    setPhotos((prev) => [...prev, ...items])
    setBusy(true)
    const queue = [...items]
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        try {
          patch(item.key, { state: 'uploading', progress: 0 })
          const mime = item.file.type || 'image/jpeg'
          const ticket = await beginJobPhotoUploadAction({ jobId: current.id, filename: item.file.name, mimeType: mime, bytes: item.file.size })
          if (!ticket.ok) { patch(item.key, { state: 'failed', detail: ticket.error.message }); continue }
          await putUploadedObject(ticket.data.uploadUrl, item.file, ticket.data.contentType, (percent) => patch(item.key, { progress: percent }))
          patch(item.key, { state: 'verifying' })
          const done = await finishJobPhotoUploadAction(ticket.data.photoId)
          if (!done.ok) { patch(item.key, { state: 'failed', detail: done.error.message }); continue }
          patch(item.key, { state: 'uploaded', progress: 100 })
          setUploaded(done.data.photoCount)
        } catch (cause) {
          patch(item.key, { state: 'failed', detail: cause instanceof Error ? cause.message : String(cause) })
        }
      }
    }))
    setBusy(false)
  }, [ensureJob, patch])

  const send = useCallback(async () => {
    if (!job) return
    setBusy(true)
    const result = await queueJobAction(job.id)
    setBusy(false)
    if (!result.ok) { setMessage(result.error.message); return }
    setJobs(result.data)
    setJob(null); setPhotos([]); setUploaded(0); setLabel(defaultJobLabel(new Date())); setMessage(null)
  }, [job])

  const failed = photos.filter((p) => p.state === 'failed').length
  const inFlight = photos.some((p) => p.state === 'uploading' || p.state === 'verifying')

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-24">
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <h1 className="text-lg font-semibold">New batch</h1>
        <p className="mt-1 text-sm text-muted-foreground">Photos go straight to the enhancer. Finals appear in the Console with a tag.</p>
        <label className="mt-4 block text-sm font-medium">
          Batch label
          <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={job !== null} maxLength={80}
            ref={(el) => { if (el && !el.value && !label) { const v = defaultJobLabel(new Date()); el.value = v; setLabel(v) } }}
            className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-3 text-base disabled:opacity-60" />
        </label>
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }} />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy && inFlight}
          className="mt-4 w-full rounded-xl bg-primary px-4 py-4 text-base font-semibold text-primary-foreground disabled:opacity-60">
          {photos.length === 0 ? 'Add photos' : 'Add more photos'}
        </button>
        {photos.length > 0 && (
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((p) => (
              <li key={p.key} className="relative aspect-square overflow-hidden rounded-xl bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.previewUrl} alt={p.file.name} className="size-full object-cover" />
                <span className={cn('absolute inset-x-0 bottom-0 px-1.5 py-1 text-[11px] font-medium text-white',
                  p.state === 'uploaded' ? 'bg-emerald-600/90' : p.state === 'failed' ? 'bg-red-600/90' : 'bg-black/60')} title={p.detail ?? undefined}>
                  {p.state === 'uploaded' ? 'Uploaded' : p.state === 'failed' ? 'Failed' : p.state === 'verifying' ? 'Checking' : `${p.progress}%`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {failed > 0 && <p className="mt-2 text-sm text-red-600">{failed} photo{failed === 1 ? '' : 's'} failed. Tap Add more photos to retry them.</p>}
        {message && <p className="mt-2 text-sm text-red-600">{message}</p>}
        <button type="button" onClick={() => void send()} disabled={!job || uploaded === 0 || inFlight || busy}
          className="mt-4 w-full rounded-xl border-2 border-primary px-4 py-4 text-base font-semibold text-primary disabled:opacity-50">
          Send for enhancement{uploaded > 0 ? ` (${uploaded} photo${uploaded === 1 ? '' : 's'})` : ''}
        </button>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Batches</h2>
          <button type="button" className="text-sm text-muted-foreground underline" onClick={async () => { const r = await listJobsAction(); if (r.ok) setJobs(r.data); setNow(new Date()) }}>Refresh</button>
        </div>
        <ul className="mt-2 divide-y divide-border rounded-2xl border border-border bg-card">
          {jobs.length === 0 && <li className="p-4 text-sm text-muted-foreground">No batches yet.</li>}
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-col gap-1 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{j.label}</span>
                <StatusChip job={j} now={now} />
              </div>
              <div className="text-sm text-muted-foreground">
                {j.photoCount} photo{j.photoCount === 1 ? '' : 's'}
                {j.status === 'done' && ` · ${j.resultCount} final${j.resultCount === 1 ? '' : 's'} in the Console`}
                {j.runner && ` · ${j.runner}`}
              </div>
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
