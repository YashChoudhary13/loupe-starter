'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  beginIdentifyUploadAction,
  confirmIdentifyAction,
  decideIntakeAction,
  finalizeIdentifyUploadAction,
  refreshIdentifyAction,
} from '@/app/(shell)/identify/actions'
import { ImageLightbox, type LightboxImage } from '@/components/console/ImageLightbox'
import { Notice } from '@/components/console/primitives'
import { putUploadedObject } from '@/components/upload/put-object'
import { LIVE_ACTIVITY_EVENT, shouldRefreshIdentify, type LiveActivityUpdate } from '@/lib/live/types'
import type { IdentifyCandidate, IdentifyItem, IdentifySnapshot } from '@/lib/match/read-model'
import { cn } from '@/lib/utils'

/**
 * Identify (D110). Ten candidates, always, in rank order, all styled alike: the
 * score cannot tell a right answer from a wrong one (AUC 0.63), so nothing here
 * is highlighted as "best" and nothing is decided without a person.
 */

const WORKER_OFFLINE_MS = 2 * 60 * 1000
const QUEUED_POLL_MS = 5_000

function relativeAge(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function IdentifyScreen({ initialSnapshot }: { initialSnapshot: IdentifySnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ title: string; detail: string | null } | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const inFlight = useRef(false)
  // Clock of the snapshot, not of the render: hooks must stay pure.
  const now = new Date(snapshot.generatedAt).getTime()

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const result = await refreshIdentifyAction()
      if (result.ok) setSnapshot(result.data)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    const onLive = (event: Event) => {
      const update = (event as CustomEvent<LiveActivityUpdate>).detail
      if (update?.snapshot && shouldRefreshIdentify(update.snapshot.events)) void refresh()
    }
    window.addEventListener(LIVE_ACTIVITY_EVENT, onLive)
    return () => window.removeEventListener(LIVE_ACTIVITY_EVENT, onLive)
  }, [refresh])

  // A queued photograph is waiting on the worker; poll gently until it answers.
  const anyQueued = snapshot.items.some((item) => item.status === 'queued')
  useEffect(() => {
    if (!anyQueued) return
    const timer = window.setInterval(() => void refresh(), QUEUED_POLL_MS)
    return () => window.clearInterval(timer)
  }, [anyQueued, refresh])

  const decide = useCallback(
    async (item: IdentifyItem, decision: string, sku: string | null, rank: number | null) => {
      setBusy(item.matchEventId)
      setNotice(null)
      try {
        const result = item.intakeFileId
          ? await decideIntakeAction({
              matchEventId: item.matchEventId,
              decision: decision as 'new_product' | 'restock' | 'skipped',
              sku,
              rank,
            })
          : await confirmIdentifyAction({
              matchEventId: item.matchEventId,
              decision: decision as 'confirmed' | 'none_of_these',
              sku,
              rank,
            })
        if (result.ok) setSnapshot(result.data)
        else setNotice({ title: result.error, detail: result.detail })
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const takePhoto = useCallback(async (file: File) => {
    setUploading(file.name)
    setNotice(null)
    try {
      const ticket = await beginIdentifyUploadAction({ filename: file.name, mimeType: file.type, bytes: file.size })
      if (!ticket.ok) {
        setNotice({ title: ticket.error, detail: ticket.detail })
        return
      }
      await putUploadedObject(ticket.data.uploadUrl, file, ticket.data.contentType, () => undefined)
      const finalised = await finalizeIdentifyUploadAction({ uploadId: ticket.data.uploadId })
      if (!finalised.ok) {
        setNotice({ title: finalised.error, detail: finalised.detail })
        return
      }
      await refresh()
    } catch (cause) {
      setNotice({ title: 'The photograph could not be uploaded.', detail: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setUploading(null)
    }
  }, [refresh])

  const workerOffline = !snapshot.workerSeenAt || now - new Date(snapshot.workerSeenAt).getTime() > WORKER_OFFLINE_MS

  return (
    <main className="loupe-scroll flex min-h-0 min-w-0 flex-col gap-3.5 overflow-y-auto pr-1">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Identify</h1>
          <div className="text-[12px] text-muted-foreground">
            Is this already a product? Ten candidates, in rank order — you decide, nothing decides for you.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={cn('rounded-pill px-3 py-1.5 text-[11px]', workerOffline ? 'bg-[#faf4e9] text-amber' : 'bg-chip text-ink-soft')}
            title={snapshot.workerSeenAt ?? 'no worker has reported yet'}
          >
            {workerOffline
              ? snapshot.workerSeenAt
                ? `Matcher offline — last seen ${relativeAge(snapshot.workerSeenAt, now)}`
                : 'Matcher has not started yet'
              : `Matcher online · ${relativeAge(snapshot.workerSeenAt!, now)}`}
          </span>
          <label className="cursor-pointer rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#242428]">
            {uploading ? `Uploading ${uploading}…` : 'Photograph a piece'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="sr-only"
              disabled={uploading !== null}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void takePhoto(file)
              }}
            />
          </label>
        </div>
      </div>

      {notice ? (
        <Notice tone="attention" title={notice.title} detail={notice.detail} />
      ) : null}

      {snapshot.items.length === 0 ? (
        <div className="rounded-panel bg-surface px-5 py-8 text-center text-[12.5px] text-muted-foreground">
          Nothing is waiting. New photographs from Drive and Upload appear here before enhancement; a photograph
          taken with the button above appears here too.
        </div>
      ) : null}

      {snapshot.items.map((item) => (
        <IdentifyCard
          key={item.matchEventId}
          item={item}
          now={now}
          busy={busy === item.matchEventId}
          workerOffline={workerOffline}
          onDecide={(decision, sku, rank) => void decide(item, decision, sku, rank)}
        />
      ))}

      {snapshot.truncated ? (
        <div className="text-[11px] text-muted-foreground">Showing the newest 200; decide some to see the rest.</div>
      ) : null}
    </main>
  )
}

function IdentifyCard({
  item,
  now,
  busy,
  workerOffline,
  onDecide,
}: {
  item: IdentifyItem
  now: number
  busy: boolean
  workerOffline: boolean
  onDecide: (decision: string, sku: string | null, rank: number | null) => void
}) {
  const [picked, setPicked] = useState<IdentifyCandidate | null>(null)
  const [typed, setTyped] = useState('')
  const [view, setView] = useState<number | null>(null)
  const isIntake = item.intakeFileId !== null
  // Lightbox order: the photograph first, then the candidates that have an image.
  const shown = (item.candidates ?? []).filter((c) => c.thumbUrl)
  const lightbox: { images: LightboxImage[]; candidates: (IdentifyCandidate | null)[] } = {
    images: [
      ...(item.thumb
        ? [{ url: item.thumb.url, thumbUrl: item.thumb.url, alt: item.filename, caption: `${item.filename} — your photograph` }]
        : []),
      ...shown.map((c) => ({
        url: c.fullUrl ?? c.thumbUrl!,
        thumbUrl: c.thumbUrl,
        alt: c.sku,
        caption: `#${c.rank} ${c.sku}${c.title ? ` — ${c.title}` : ''}`,
      })),
    ],
    candidates: [...(item.thumb ? [null] : []), ...shown],
  }
  const viewed = view === null ? null : (lightbox.candidates[view] ?? null)
  const pick = (c: IdentifyCandidate) => {
    setPicked(picked?.rank === c.rank ? null : c)
    setTyped('')
  }
  const chosenSku = picked?.sku ?? typed.trim().toUpperCase() ?? ''
  const chosenRank = picked?.rank ?? null
  const sourceLabel = item.surface === 'drive' ? 'Drive' : item.surface === 'upload' ? 'Upload' : 'Photographed'

  return (
    <section className="rounded-[24px] bg-surface p-4">
      <div className="flex gap-4">
        <div className="size-[132px] shrink-0 overflow-hidden rounded-[16px] bg-chip">
          {item.thumb ? (
            <button type="button" onClick={() => setView(0)} aria-label="View the photograph full size" className="size-full cursor-zoom-in">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.thumb.url} alt="" className="size-full object-cover" />
            </button>
          ) : (
            <div className="grid size-full place-items-center px-2 text-center text-[10px] text-muted-foreground">
              {item.status === 'queued' ? 'preview arrives with the match' : 'no preview'}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-mono text-[12px]">{item.filename}</span>
            <span className="rounded-pill bg-chip px-2 py-0.5 text-[10px] text-ink-soft">{sourceLabel}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{relativeAge(item.requestedAt, now)}</span>
          </div>

          {item.status === 'queued' ? (
            <div className="mt-3 text-[12.5px] text-ink-soft">
              {workerOffline
                ? 'The matcher is offline. The photograph is safe; it will be matched when the worker returns, or decide now without candidates.'
                : 'Matching against the catalogue…'}
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-5 gap-2 sm:grid-cols-10">
              {(item.candidates ?? []).map((c) => {
                const at = lightbox.candidates.indexOf(c)
                return (
                  <div
                    key={c.rank}
                    className={cn(
                      'flex flex-col items-stretch gap-1 rounded-[14px] border-2 p-1 transition-colors',
                      picked?.rank === c.rank ? 'border-ink' : 'border-transparent hover:border-[#d6d6d6]',
                    )}
                  >
                    {/* The picture opens full size; the label underneath picks. */}
                    <button
                      type="button"
                      disabled={at < 0}
                      onClick={() => setView(at)}
                      aria-label={`View ${c.sku} full size`}
                      className="aspect-square overflow-hidden rounded-[10px] bg-chip enabled:cursor-zoom-in"
                    >
                      {c.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.thumbUrl} alt="" className="size-full object-cover" loading="lazy" />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => pick(c)}
                      aria-pressed={picked?.rank === c.rank}
                      title={c.title ?? c.handle ?? c.sku}
                      className="min-w-0 text-left"
                    >
                      <div className="truncate text-[10.5px] font-medium">{c.sku}</div>
                      <div className="truncate text-[9.5px] text-muted-foreground">{c.title ?? c.handle ?? ''}</div>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isIntake ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDecide('new_product', null, null)}
                  className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white hover:bg-[#242428] disabled:opacity-50"
                >
                  New product — enhance it
                </button>
                <button
                  type="button"
                  disabled={busy || !chosenSku}
                  onClick={() => onDecide('restock', chosenSku, chosenRank)}
                  className="rounded-pill bg-chip px-4 py-2 text-[12px] font-medium text-ink hover:bg-[#e7e7e7] disabled:opacity-50"
                >
                  {chosenSku ? `Restock of ${chosenSku}` : 'Restock of … (pick one)'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDecide('skipped', null, null)}
                  className="rounded-pill px-3 py-2 text-[11.5px] text-muted-foreground hover:text-ink disabled:opacity-50"
                >
                  Can&apos;t tell — enhance anyway
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy || !chosenSku}
                  onClick={() => onDecide('confirmed', chosenSku, chosenRank)}
                  className="rounded-pill bg-ink px-4 py-2 text-[12px] font-medium text-white hover:bg-[#242428] disabled:opacity-50"
                >
                  {chosenSku ? `It's ${chosenSku}` : "It's … (pick one)"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDecide('none_of_these', null, null)}
                  className="rounded-pill bg-chip px-4 py-2 text-[12px] font-medium text-ink hover:bg-[#e7e7e7] disabled:opacity-50"
                >
                  None of these
                </button>
              </>
            )}
            <input
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value)
                setPicked(null)
              }}
              placeholder="or type a SKU"
              aria-label="SKU"
              className="ml-auto w-36 rounded-pill bg-chip px-3 py-2 font-mono text-[11.5px] uppercase outline-none focus:shadow-[0_0_0_2px_var(--ink)_inset]"
            />
          </div>
        </div>
      </div>
      <ImageLightbox
        images={lightbox.images}
        index={view}
        onClose={() => setView(null)}
        onIndexChange={setView}
        action={
          viewed && !busy
            ? {
                label: picked?.rank === viewed.rank ? `Picked ${viewed.sku} · unpick` : `It's ${viewed.sku}`,
                onClick: () => {
                  pick(viewed)
                  setView(null)
                },
              }
            : null
        }
      />
    </section>
  )
}
