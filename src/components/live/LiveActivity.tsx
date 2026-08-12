'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { liveActivityAction } from '@/app/live/actions'
import {
  LIVE_ACTIVITY_EVENT,
  noticesForLiveEvents,
  type LiveActivitySnapshot,
  type LiveActivityUpdate,
  type LiveNotice,
} from '@/lib/live/types'
import { cn } from '@/lib/utils'

const POLL_MS = 4_000
const NOTICE_MS = 6_000
const CURSOR_KEY = 'loupe.live-event-cursor.v1'

interface VisibleNotice extends LiveNotice {
  readonly instance: number
}

function readCursor(): number | null {
  try {
    const raw = window.sessionStorage.getItem(CURSOR_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function writeCursor(value: number | null): void {
  if (value === null) return
  try {
    window.sessionStorage.setItem(CURSOR_KEY, String(value))
  } catch {
    // A locked-down or private browser may refuse storage. Polling still works
    // for the lifetime of this component through the in-memory ref.
  }
}

/** Site-wide pipeline heartbeat, mounted by the shared authenticated sidebar. */
export function LiveActivity({ compact = false }: { compact?: boolean } = {}) {
  const [snapshot, setSnapshot] = useState<LiveActivitySnapshot | null>(null)
  const [notices, setNotices] = useState<readonly VisibleNotice[]>([])
  const cursorRef = useRef<number | null>(null)
  const instanceRef = useRef(0)

  useEffect(() => {
    let stopped = false
    let inFlight = false
    cursorRef.current = readCursor()

    const poll = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      const requestedCursor = cursorRef.current
      try {
        const result = await liveActivityAction(requestedCursor)
        if (stopped || !result.ok) return

        const next = result.data
        const initial = requestedCursor === null
        cursorRef.current = next.revision
        writeCursor(next.revision)
        setSnapshot(next)

        const update: LiveActivityUpdate = { initial, snapshot: next }
        window.dispatchEvent(new CustomEvent<LiveActivityUpdate>(LIVE_ACTIVITY_EVENT, { detail: update }))

        if (!initial && next.events.length > 0) {
          const incoming = noticesForLiveEvents(next.events).map((notice) => ({
            ...notice,
            instance: ++instanceRef.current,
          }))
          if (incoming.length > 0) setNotices((current) => [...current, ...incoming])
        }
      } finally {
        inFlight = false
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    const onFocus = () => void poll()

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (notices.length === 0) return
    const timer = window.setTimeout(() => setNotices((current) => current.slice(1)), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notices])

  const queued = snapshot?.queued ?? 0
  const enhancing = snapshot?.enhancing ?? 0
  const active = queued + enhancing > 0

  return (
    <>
      {notices.length > 0 ? (
        <div
          className="fixed left-1/2 top-5 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
          role="status"
          aria-live="polite"
        >
          {notices.map((notice) => (
            <Link
              key={`${notice.key}:${notice.instance}`}
              href={notice.href}
              className={cn(
                'flex items-center gap-2.5 rounded-pill px-4 py-2.5 text-[12.5px] text-white shadow-lg backdrop-blur-sm',
                notice.tone === 'attention' ? 'bg-amber' : 'bg-ink/95',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full bg-white/85',
                  notice.tone === 'progress' && 'animate-pulse',
                )}
                aria-hidden
              />
              {notice.text}
            </Link>
          ))}
        </div>
      ) : null}

      {active ? (
        compact ? (
          <Link
            href="/tracking"
            title={`${queued} queued · ${enhancing} enhancing`}
            aria-label={`${queued} queued, ${enhancing} enhancing. Open Tracking.`}
            className="mx-auto grid size-8 place-items-center rounded-full bg-ink/95 shadow-sm"
          >
            <span className="size-2 animate-pulse rounded-full bg-white/85" aria-hidden />
          </Link>
        ) : (
          <Link
            href="/tracking"
            className="flex w-full items-center justify-center gap-2 rounded-pill bg-ink/95 px-3 py-2.5 text-[11.5px] text-white shadow-sm transition-transform hover:-translate-y-0.5"
            aria-label={`${queued} queued, ${enhancing} enhancing. Open Tracking.`}
          >
            <span className="size-1.5 animate-pulse rounded-full bg-white/85" aria-hidden />
            {queued > 0 ? `${queued} queued` : null}
            {queued > 0 && enhancing > 0 ? <span className="text-white/55">·</span> : null}
            {enhancing > 0 ? `${enhancing} enhancing` : null}
          </Link>
        )
      ) : null}
    </>
  )
}
