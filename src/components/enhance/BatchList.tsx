'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { photoUrlAction } from '@/app/(shell)/enhance/actions'
import { queueIsStale } from '@/lib/agent-jobs/label'
import type { JobSummary } from '@/lib/agent-jobs/server'
import { clockTime, finishedPhotos, leftPhotos, photoReason, totalPhotos, type JobPhoto, type PhotoState } from '@/lib/agent-jobs/tracking'
import { cn } from '@/lib/utils'

/**
 * D170 — the batches, photograph by photograph. Each batch says how many are done and how many are
 * left; its grid shows every photograph with its own state, and "Not done" filters to the leftovers.
 * A tap on a photograph says why, and a failed one can be sent back.
 */

const small = 'shrink-0 rounded-pill bg-chip px-3.5 py-[7px] text-[11.5px] text-ink-soft transition-colors hover:bg-[#ebebeb] disabled:opacity-45'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type Filter = 'all' | 'notdone' | 'done' | 'restock' | 'failed'
const TAG: Record<PhotoState, string> = { waiting: 'Waiting', working: 'Working', done: 'Done', restock: 'Restock', failed: 'Failed' }

export interface BatchListProps {
  readonly jobs: readonly JobSummary[]
  readonly photos: Readonly<Record<string, readonly JobPhoto[]>>
  readonly thumbs: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly open: ReadonlySet<string>
  readonly now: Date
  readonly busy: boolean
  /** The batch being collected in the upload card, and how many photographs it holds so far. */
  readonly currentJobId: string | null
  readonly uploaded: number
  readonly onToggle: (jobId: string) => void
  readonly onResume: (job: JobSummary) => void
  readonly onRetry: (jobId: string, photoIds: readonly string[] | null) => void
}

export function BatchList(props: BatchListProps) {
  const { jobs } = props
  if (jobs.length === 0) return <p className="rounded-panel bg-surface p-4 text-[12.5px] text-muted-foreground">No batches yet.</p>
  return <>{jobs.map((j) => <Batch key={j.id} job={j} {...props} />)}</>
}

function Batch({ job: j, photos, thumbs, open, now, busy, currentJobId, uploaded, onToggle, onResume, onRetry }: BatchListProps & { job: JobSummary }) {
  const total = totalPhotos(j.counts)
  const finished = finishedPhotos(j.counts)
  const left = leftPhotos(j.counts)
  const sent = j.status !== 'collecting' && total > 0
  const isOpen = open.has(j.id)
  const resumeAt = clockTime(j.notBefore, now)
  return (
    <article className="rounded-panel bg-surface p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] font-medium">
          {j.label}
          {j.kind !== 'batch' && <span className="ml-2 rounded-pill bg-chip px-2 py-0.5 text-[10px] font-normal text-muted-foreground">{j.kind === 'redo' ? 'redo' : 'from Restock'}</span>}
        </span>
        <Status job={j} now={now} />
      </div>

      {sent ? (
        <>
          <p className="mt-1.5 text-[14px] font-medium tabular-nums tracking-[-0.01em]">
            {finished} of {total} done{left > 0 ? ` · ${left} left` : ''}
          </p>
          <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-pill bg-chip" aria-hidden>
            <span className="h-full bg-ink" style={{ width: `${(finished / total) * 100}%` }} />
            <span className="h-full bg-[#a3a3a3]" style={{ width: `${(j.counts.working / total) * 100}%` }} />
            <span className="h-full bg-amber" style={{ width: `${(j.counts.failed / total) * 100}%` }} />
          </div>
        </>
      ) : (
        <p className="mt-1 text-[12px] text-muted-foreground">{plural(currentJobId === j.id ? uploaded : j.photoCount, 'photo')}</p>
      )}

      {j.kind !== 'batch' && j.instructions && <p className="mt-1.5 text-[12px] text-ink-soft">“{j.instructions}”</p>}
      {j.status === 'running' && <p className="mt-1.5 text-[12px] text-ink-soft">Claude is matching, rendering and checking {plural(j.counts.working, 'photo')}. Finished images appear in the Console as they land.</p>}
      {j.status === 'queued' && j.holdReason === 'limit' && (
        <p className="mt-1.5 text-[12px] text-ink-soft">The limit ran out. {plural(j.counts.waiting, 'photo')} wait in the queue{resumeAt ? ` and start again by themselves at ${resumeAt}` : ''}. Nothing is lost.</p>
      )}
      {j.status === 'queued' && j.holdReason === 'login' && (
        <p className="mt-1.5 text-[12px] text-amber">Waiting for a sign-in on the server. {plural(j.counts.waiting, 'photo')} start by themselves after it.</p>
      )}
      {j.status === 'queued' && !j.holdReason && (queueIsStale(j.queuedAt, now) && !j.notBefore
        ? <p className="mt-1.5 text-[12px] text-amber">Nothing has picked this up yet.</p>
        : <p className="mt-1.5 text-[12px] text-ink-soft">{j.passes > 0 ? `${plural(j.counts.waiting, 'photo')} back in the queue, going again shortly.` : 'Waiting for Claude, usually under a minute.'}</p>)}
      {j.note && <p className="mt-1.5 line-clamp-6 whitespace-pre-line text-[12px] text-ink-soft">{j.note}</p>}
      {j.error && j.counts.failed > 0 && <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[12px] text-amber">{j.error}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {sent && <button type="button" className={small} aria-expanded={isOpen} onClick={() => onToggle(j.id)}>{isOpen ? 'Hide photos' : `Show ${plural(total, 'photo')}`}</button>}
        {j.counts.failed > 0 && <button type="button" disabled={busy} className={cn(small, 'bg-ink text-white hover:bg-ink')} onClick={() => onRetry(j.id, null)}>Retry the {j.counts.failed} failed</button>}
        {j.counts.done > 0 && <Link href="/console" className={small}>Open Console</Link>}
        {j.counts.restock > 0 && <Link href="/restock" className={small}>Open Restock</Link>}
        {j.status === 'collecting' && j.kind === 'batch' && (currentJobId === j.id
          ? <span className="text-[11.5px] text-muted-foreground">open above</span>
          : <button type="button" disabled={busy} onClick={() => onResume(j)} className={small}>Continue</button>)}
      </div>

      {sent && isOpen && <PhotoGrid job={j} photos={photos[j.id]} thumbs={thumbs[j.id]} busy={busy} onRetry={onRetry} />}
    </article>
  )
}

function PhotoGrid({ job, photos, thumbs, busy, onRetry }: {
  job: JobSummary; photos: readonly JobPhoto[] | undefined; thumbs: Readonly<Record<string, string>> | undefined; busy: boolean
  onRetry: (jobId: string, photoIds: readonly string[] | null) => void
}) {
  const [filter, setFilter] = useState<Filter>(leftPhotos(job.counts) > 0 && finishedPhotos(job.counts) > 0 ? 'notdone' : 'all')
  const [selected, setSelected] = useState<string | null>(null)
  if (!photos) return <p className="mt-3 text-[12px] text-muted-foreground">Loading the photographs…</p>
  const c = job.counts
  const chips: readonly (readonly [Filter, string, number])[] = [
    ['all', 'All', photos.length], ['notdone', 'Not done', leftPhotos(c)], ['done', 'Done', c.done], ['restock', 'Restock', c.restock], ['failed', 'Failed', c.failed],
  ]
  const shows = (p: JobPhoto) => filter === 'all' || (filter === 'notdone' ? p.state !== 'done' && p.state !== 'restock' : p.state === filter)
  const visible = photos.filter(shows)
  const picked = photos.find((p) => p.id === selected) ?? null
  return (
    <div className="mt-3 flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1.5">
        {chips.filter(([key, , n]) => key === 'all' || key === 'notdone' || n > 0).map(([key, text, n]) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}
            className={cn('rounded-pill px-3 py-[6px] text-[11.5px] tabular-nums transition-colors', filter === key ? 'bg-ink font-medium text-white' : 'bg-chip text-ink-soft hover:bg-[#ebebeb]')}>
            {text} · {n}
          </button>
        ))}
      </div>
      {visible.length === 0
        ? <p className="text-[12px] text-muted-foreground">{filter === 'notdone' ? 'Every photograph of this batch is done.' : 'Nothing here.'}</p>
        : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(78px,1fr))] gap-2">
            {visible.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setSelected(p.id === selected ? null : p.id)} aria-pressed={p.id === selected} aria-label={`${p.filename}, ${TAG[p.state]}`}
                  className={cn('relative block aspect-square w-full overflow-hidden rounded-tile bg-chip text-left',
                    p.id === selected && 'outline-2 outline-offset-2 outline-ink')}>
                  {thumbs?.[p.id]
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={thumbs[p.id]} alt="" loading="lazy" className={cn('size-full object-cover', (p.state === 'waiting' || p.state === 'failed') && 'opacity-60')} />
                    : <span className="absolute inset-x-1.5 top-1.5 break-all font-mono text-[9px] leading-tight text-muted-foreground">{p.filename}</span>}
                  <span className={cn('absolute bottom-1.5 left-1.5 rounded-pill px-2 py-[3px] text-[9px] font-medium uppercase tracking-[0.05em]',
                    p.state === 'done' ? 'bg-ink text-white' : p.state === 'failed' ? 'bg-amber text-white' : p.state === 'working' ? 'animate-pulse bg-white text-ink' : 'bg-white text-ink-soft')}>
                    {p.state === 'waiting' && p.attempts > 0 ? 'Again' : TAG[p.state]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      {picked && <PhotoDetail key={picked.id} job={job} photo={picked} busy={busy} onRetry={onRetry} />}
    </div>
  )
}

function PhotoDetail({ job, photo, busy, onRetry }: { job: JobSummary; photo: JobPhoto; busy: boolean; onRetry: (jobId: string, photoIds: readonly string[] | null) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void photoUrlAction(photo.id).then((r) => { if (live && r.ok) setUrl(r.data) }).catch(() => undefined)
    return () => { live = false }
  }, [photo.id])
  return (
    <div className="flex gap-3 rounded-tile bg-chip p-3">
      <div className="size-24 shrink-0 overflow-hidden rounded-field bg-surface">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url && <img src={url} alt={photo.filename} className="size-full object-cover" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <p className="break-all text-[12px] font-medium">{photo.filename} · {TAG[photo.state]}</p>
        <p className={cn('text-[12px] leading-relaxed', photo.state === 'failed' ? 'text-amber' : 'text-ink-soft')}>{photoReason(photo, job.status)}</p>
        <div className="flex flex-wrap gap-1.5">
          {photo.state === 'failed' && <button type="button" disabled={busy} className={cn(small, 'bg-ink text-white hover:bg-ink')} onClick={() => onRetry(job.id, [photo.id])}>Retry this photo</button>}
          {photo.state === 'done' && <Link href="/console" className={cn(small, 'bg-surface')}>Open Console</Link>}
          {photo.state === 'restock' && <Link href="/restock" className={cn(small, 'bg-surface')}>Open Restock</Link>}
          {url && <a href={url} target="_blank" rel="noreferrer" className={cn(small, 'bg-surface')}>Full photo</a>}
        </div>
      </div>
    </div>
  )
}

/** Black while it runs, amber when a person is needed, grey otherwise. */
function Status({ job, now }: { job: JobSummary; now: Date }) {
  const since = job.startedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(job.startedAt)) / 60_000)) : 0
  const failed = job.counts.failed
  const until = clockTime(job.notBefore, now)
  let text: string = job.status
  let tone: 'run' | 'need' | 'plain' = 'plain'
  if (job.status === 'running') { text = `Running · ${since} min`; tone = 'run' }
  else if (job.status === 'queued' && job.holdReason === 'limit') text = until ? `Paused until ${until}` : 'Waiting for limit'
  else if (job.status === 'queued' && job.holdReason === 'login') { text = 'Needs sign-in'; tone = 'need' }
  else if (job.status === 'queued') text = job.passes > 0 ? 'Back in queue' : 'Queued'
  else if (failed > 0) { text = `${failed} need${failed === 1 ? 's' : ''} you`; tone = 'need' }
  return (
    <span className={cn('shrink-0 rounded-pill px-2.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em]',
      tone === 'need' ? 'bg-[#faf2e4] text-amber' : tone === 'run' ? 'bg-ink text-white' : 'bg-chip text-muted-foreground')}>
      {text}
    </span>
  )
}
