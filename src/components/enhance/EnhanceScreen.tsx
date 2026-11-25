'use client'

import { Check } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { enhanceStateAction, jobThumbsAction, cancelJobAction, retryPhotosAction, runnerCommandAction, type EnhanceState } from '@/app/(shell)/enhance/actions'
import { defaultJobLabel } from '@/lib/agent-jobs/label'
import type { JobSummary } from '@/lib/agent-jobs/server'
import { leftPhotos, type JobPhoto, type RunnerView } from '@/lib/agent-jobs/tracking'
import { cn } from '@/lib/utils'

import { Card, Notice, SectionLabel } from '../console/primitives'
import { BatchList } from './BatchList'
import { RunnerPanel } from './RunnerPanel'
import { addPhotos, dismissSaid, explain, plural, resumeBatch, retryFailed, sendBatch, useUploader, type PhotoItem, type Said } from './uploader'

// DESIGN.md: everything interactive is a pill; black is the one primary action, grey is available.
const big = 'flex h-12 w-full items-center justify-center rounded-pill px-5 text-[14px] font-medium transition-colors disabled:opacity-45'
const small = 'shrink-0 rounded-pill bg-chip px-3.5 py-[7px] text-[11.5px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-45'

function tileText(p: PhotoItem): string {
  if (p.state === 'waiting') return 'Waiting'
  if (p.state === 'preparing') return 'Preparing'
  // The bar counts bytes handed to the network; storage confirms a moment later.
  return p.state === 'uploading' && p.progress < 99 ? `${p.progress}%` : 'Finishing'
}

/**
 * One picked photograph. Memoised, and drawn from the small thumbnail the uploader makes (D179): sixty full-size
 * previews redrawn on every progress step were what made the page stutter and tear while scrolling.
 */
const Tile = memo(function Tile({ p }: { p: PhotoItem }) {
  return (
    <li className="relative aspect-square overflow-hidden rounded-tile bg-chip">
      {p.thumbUrl
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={p.thumbUrl} alt={p.name} decoding="async" className={cn('size-full object-cover', p.state !== 'uploaded' && 'opacity-55')} />
        : <span className="absolute inset-x-1.5 top-1.5 truncate text-[10px] text-muted-foreground">{p.name}</span>}
      {p.state === 'uploaded' && (
        <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-ink text-white" aria-label="Uploaded"><Check className="size-3" strokeWidth={3} /></span>
      )}
      {p.state === 'failed' && (
        <span title={p.detail ?? undefined} className="absolute bottom-1.5 left-1.5 rounded-pill bg-[#faf4e9] px-2.5 py-1 text-[10.5px] font-medium text-amber">Failed</span>
      )}
      {p.state !== 'uploaded' && p.state !== 'failed' && (
        <>
          <span className="absolute bottom-3 left-1.5 rounded-pill bg-white px-2.5 py-1 text-[10.5px] font-medium text-ink">{tileText(p)}</span>
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/60"><span className="block h-full bg-ink" style={{ width: `${p.progress}%` }} /></span>
        </>
      )}
    </li>
  )
})

/**
 * D143 — the phone's way in. Pick photos (camera or gallery), they go straight to
 * private storage and, once every one of them is there, the batch sends itself to the enhancer
 * (D179; the uploader lives in `uploader.ts` and keeps going when this screen is left). Every step
 * answers on screen: a tile per photo the moment it is picked, its progress, and why it failed.
 */
/** Open by default: a batch in the queue or running, and a finished one that still has photographs left. */
const opensByDefault = (j: JobSummary) => j.status === 'queued' || j.status === 'running' || (j.status !== 'collecting' && leftPhotos(j.counts) > 0 && Date.now() - Date.parse(j.createdAt) < 3 * 86_400_000)

export function EnhanceScreen({ initialJobs, initialRunner }: { initialJobs: readonly JobSummary[]; initialRunner: RunnerView | null }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [runner, setRunner] = useState(initialRunner)
  const [jobPhotos, setJobPhotos] = useState<Readonly<Record<string, readonly JobPhoto[]>>>({})
  const [thumbs, setThumbs] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>({})
  // What the operator opened or closed by hand wins over the default.
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({})
  const open = useMemo(() => new Set(jobs.filter((j) => toggled[j.id] ?? opensByDefault(j)).map((j) => j.id)), [jobs, toggled])
  const openKey = [...open].sort().join(',')
  // Server and browser clocks differ, so the default label is set in the browser's time zone once the input mounts.
  const [label, setLabel] = useState('')
  const up = useUploader()
  const { job, photos, uploaded } = up
  const [working, setBusy] = useState(false)
  const busy = working || up.busy
  const [ownSaid, setSaid] = useState<Said | null>(null)
  // A stale page outranks everything; otherwise the uploader's news (sent, held) is the newer line.
  const said = ownSaid?.stale ? ownSaid : up.said ?? ownSaid
  const inputRef = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => new Date())

  // A batch just sent (by itself or by a tap): the list as the server answered it, and a fresh label for the next one.
  // (State adjusted while rendering, React's pattern for "a value changed": the emptied label is filled by the input below.)
  const [seenSent, setSeenSent] = useState(up.sentAt)
  if (seenSent !== up.sentAt) {
    setSeenSent(up.sentAt); setLabel('')
    if (up.jobs) setJobs(up.jobs)
  }
  // The batch being filled shows in the list at once, before the next poll brings it.
  const shownJobs = useMemo(() => (job && !jobs.some((j) => j.id === job.id) ? [job, ...jobs] : jobs), [job, jobs])

  const take = useCallback((state: EnhanceState) => {
    setJobs(state.jobs); setRunner(state.runner); setJobPhotos((prev) => ({ ...prev, ...state.photos })); setNow(new Date())
  }, [])

  const refresh = useCallback(async () => {
    try {
      const result = await enhanceStateAction(openKey ? openKey.split(',') : [])
      if (result.ok) take(result.data)
    } catch (cause) {
      const why = explain(cause)
      if (why.stale) setSaid(why)
    }
  }, [openKey, take])

  // States only, never an image: every 5 s while something moves (a batch in the queue or running, a
  // sign-in under way), every 30 s otherwise so the limits stay current. Nothing while the tab is hidden.
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running') || (runner?.login != null && runner.login.state !== 'ok' && runner.login.state !== 'failed')
  useEffect(() => {
    const tick = () => { if (!document.hidden) void refresh() }
    // `refresh` changes when a batch is opened or closed, so this also fetches a newly opened batch's photographs at once.
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, active ? 5_000 : 30_000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearTimeout(first); window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [active, refresh])

  // A batch that opens gets its thumbnails once (a poll never re-signs them).
  const thumbsAsked = useRef(new Set<string>())
  useEffect(() => {
    for (const id of openKey ? openKey.split(',') : []) {
      if (thumbsAsked.current.has(id)) continue
      thumbsAsked.current.add(id)
      void jobThumbsAction(id).then((r) => { if (r.ok) setThumbs((prev) => ({ ...prev, [id]: r.data })) }).catch(() => thumbsAsked.current.delete(id))
    }
  }, [openKey])

  const retry = useCallback(async (jobId: string, photoIds: readonly string[] | null) => {
    setBusy(true)
    try {
      const result = await retryPhotosAction(jobId, photoIds, openKey ? openKey.split(',') : [])
      if (result.ok) take(result.data)
      else setSaid({ text: result.error.message, tone: 'error', stale: false })
    } catch (cause) {
      setSaid(explain(cause))
    } finally {
      setBusy(false)
    }
  }, [openKey, take])

  const cancel = useCallback(async (jobId: string) => {
    setBusy(true)
    try {
      const result = await cancelJobAction(jobId, openKey ? openKey.split(',') : [])
      if (result.ok) take(result.data)
      else setSaid({ text: result.error.message, tone: 'error', stale: false })
    } catch (cause) {
      setSaid(explain(cause))
    } finally {
      setBusy(false)
    }
  }, [openKey, take])

  const command = useCallback(async (kind: string, payload: Record<string, string> = {}): Promise<string | null> => {
    try {
      const result = await runnerCommandAction(kind, payload)
      if (!result.ok) return result.error.message
      window.setTimeout(() => { void refresh() }, 2_000)
      return null
    } catch (cause) {
      return explain(cause).text
    }
  }, [refresh])

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
              : <button type="button" onClick={() => { setSaid(null); dismissSaid() }} className="text-[11.5px] underline underline-offset-2">Dismiss</button>}
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
              {photos.map((p) => <Tile key={p.key} p={p} />)}
            </ul>
          )}
          {photos.length > 0 && (
            <p className="mt-2 text-[12px] text-muted-foreground">
              {landed} of {photos.length} uploaded
              {failed.length > 0 && <span className="text-amber"> · {failed.length} failed{failed[0]?.detail ? `: ${failed[0].detail}` : ''}</span>}
              {busy && failed.length === 0 && ' · goes to Claude by itself when all are up; you can leave this page, but keep Loupe open'}
            </p>
          )}
          {job && photos.length === 0 && <p className="mt-2 text-[12px] text-muted-foreground">{plural(uploaded, 'photo')} already in this batch.</p>}

          {/* The FileList is live: resetting the input empties it, so the files are copied out first. */}
          <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void addPhotos(files, label) }} />
          <div className="mt-3.5 flex flex-col gap-2">
            {failed.length > 0 && !busy && (
              <button type="button" onClick={retryFailed} className={cn(big, 'bg-ink text-white')}>Retry {plural(failed.length, 'failed photo')}</button>
            )}
            <button type="button" onClick={() => inputRef.current?.click()} disabled={working}
              className={cn(big, uploaded > 0 ? 'bg-chip text-ink-soft' : 'bg-ink text-white')}>
              {up.busy && photos.length > 0 ? `Uploading ${Math.min(landed + 1, photos.length)} of ${photos.length} · add more` : started ? 'Add more photos' : 'Add photos'}
            </button>
            {started && (
              <button type="button" onClick={() => void sendBatch()} disabled={!job || uploaded === 0 || busy} className={cn(big, failed.length > 0 ? 'bg-chip text-ink-soft' : 'bg-ink text-white')}>
                {failed.length > 0 ? `Send without them · ${plural(uploaded, 'photo')}` : `Send to Claude${uploaded > 0 ? ` · ${plural(uploaded, 'photo')}` : ''}`}
              </button>
            )}
          </div>
        </Card>

        <RunnerPanel runner={runner} now={now} onCommand={command} />

        <div className="mt-2 flex items-center justify-between">
          <SectionLabel>Batches</SectionLabel>
          <button type="button" className={small} onClick={() => void refresh()}>Refresh</button>
        </div>
        <div className="flex flex-col gap-2 pb-10">
          <BatchList jobs={shownJobs} photos={jobPhotos} thumbs={thumbs} open={open} now={now} busy={busy}
            currentJobId={job?.id ?? null} uploaded={uploaded}
            onToggle={(id) => setToggled((prev) => ({ ...prev, [id]: !open.has(id) }))} onResume={(j) => { setSaid(null); resumeBatch(j); window.scrollTo({ top: 0, behavior: 'smooth' }) }} onRetry={(id, ids) => void retry(id, ids)} onCancel={(id) => void cancel(id)} />
        </div>
      </div>
    </section>
  )
}
