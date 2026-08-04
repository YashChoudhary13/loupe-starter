'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  discardIntakeAction,
  refreshTrackingAction,
  resumeIntakeAction,
  retryIntakeAction,
  reviewDuplicateAction,
  runFullReconciliationAction,
  skipIntakeAction,
} from '@/app/tracking/actions'
import type { Operator } from '@/lib/auth/authorize'
import {
  LIVE_ACTIVITY_EVENT,
  shouldRefreshTracking,
  type LiveActivityUpdate,
} from '@/lib/live/types'
import { filterTrackingRows, type TrackingFilters } from '@/lib/tracking/filters'
import type { TrackingRow, TrackingSnapshot } from '@/lib/tracking/types'
import { cn } from '@/lib/utils'

import { Sidebar } from '@/components/console/Sidebar'

const DEFAULT_FILTERS: TrackingFilters = {
  view: 'attention',
  status: 'any',
  error: '',
  age: 'any',
  search: '',
}

const TRACKING_URL_REFRESH_MS = 9 * 60 * 1000

/** Keep valid signed thumbnails when only the row state changed. */
function preserveTrackingThumbs(
  previous: TrackingSnapshot,
  next: TrackingSnapshot,
  now = Date.now(),
): TrackingSnapshot {
  const previousThumbs = new Map(
    previous.rows
      .filter((row) => row.thumb && row.thumb.expiresAt > now + 60_000)
      .map((row) => [row.rowId, row.thumb] as const),
  )
  if (previousThumbs.size === 0) return next

  let preserved = false
  const rows = next.rows.map((row) => {
    const thumb = previousThumbs.get(row.rowId)
    if (!thumb || !row.thumb) return row
    preserved = true
    return { ...row, thumb }
  })
  return {
    ...next,
    rows,
    signedUntil: preserved ? Math.min(previous.signedUntil, next.signedUntil) : next.signedUntil,
  }
}

function relativeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function TrackingScreen({
  operator,
  initialSnapshot,
}: {
  operator: Operator
  initialSnapshot: TrackingSnapshot
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const liveRefreshInFlight = useRef(false)
  const now = new Date(snapshot.generatedAt).getTime()
  const rows = useMemo(
    () => filterTrackingRows(snapshot.rows, filters, now),
    [snapshot.rows, filters, now],
  )
  const errorOptions = useMemo(
    () =>
      [...new Set(snapshot.rows.map((row) => row.errorCode).filter((code): code is string => Boolean(code)))]
        .sort(),
    [snapshot.rows],
  )

  const refreshFromLiveActivity = useCallback(async (preserveThumbs: boolean) => {
    if (liveRefreshInFlight.current) return
    liveRefreshInFlight.current = true
    try {
      const result = await refreshTrackingAction()
      if (!result.ok) return
      setSnapshot((current) =>
        preserveThumbs ? preserveTrackingThumbs(current, result.data) : result.data,
      )
    } finally {
      liveRefreshInFlight.current = false
    }
  }, [])

  /**
   * Tracking used to be a static server snapshot. Follow the shared audit
   * heartbeat so Queued -> Enhancing -> Enhanced/Failed changes appear while
   * the operator is looking at the page, without refreshing the browser.
   */
  useEffect(() => {
    const onLiveActivity = (rawEvent: Event) => {
      const update = (rawEvent as CustomEvent<LiveActivityUpdate>).detail
      if (
        update?.initial ||
        busy !== null ||
        !shouldRefreshTracking(update?.snapshot.events ?? [])
      ) {
        return
      }
      void refreshFromLiveActivity(true)
    }
    window.addEventListener(LIVE_ACTIVITY_EVENT, onLiveActivity)
    return () => window.removeEventListener(LIVE_ACTIVITY_EVENT, onLiveActivity)
  }, [busy, refreshFromLiveActivity])

  /** Signed thumbnails refresh even during a quiet session. */
  useEffect(() => {
    const timer = window.setInterval(
      () => void refreshFromLiveActivity(false),
      TRACKING_URL_REFRESH_MS,
    )
    return () => window.clearInterval(timer)
  }, [refreshFromLiveActivity])

  const update = async (
    key: string,
    run: () => Promise<
      | { ok: true; data: TrackingSnapshot }
      | { ok: false; error: string; detail: string | null }
    >,
    success: string,
  ) => {
    setBusy(key)
    setFeedback(null)
    setDetail(null)
    const result = await run()
    setBusy(null)
    if (result.ok) {
      setSnapshot(result.data)
      setFeedback(success)
    } else {
      setFeedback(result.error)
      setDetail(result.detail)
    }
  }

  const reconcile = async () => {
    const confirmed = window.confirm(
      'Run full Shopify reconciliation now?\n\n' +
        'This checks product status and catalogue differences, reflects drafts published from Shopify, ' +
        'and raises future per-category SKU counters if Shopify is ahead.\n\n' +
        'It never lowers a counter, reuses a deleted SKU, or silently rewrites an existing product.',
    )
    if (!confirmed) return

    setBusy('reconcile')
    setFeedback(null)
    setDetail(null)
    const result = await runFullReconciliationAction()
    setBusy(null)
    if (result.ok) {
      setSnapshot(result.data.snapshot)
      const raised = result.data.skuCounters.raised
      const counterResult =
        raised.length > 0
          ? `${raised.length} SKU counter${raised.length === 1 ? '' : 's'} raised (${raised
              .map((row) => `${row.prefix} ${row.from}→${row.to}`)
              .join(', ')}).`
          : 'SKU counters were already safe; none were lowered.'
      setFeedback(result.data.started
        ? `Full reconciliation completed: ${result.data.matchedProducts}/${result.data.totalProducts} products matched, ${result.data.issueCount} issues, ${result.data.promotedProducts} Shopify-published drafts reflected. ${counterResult}`
        : `A catalogue check was already running; no duplicate check was started. ${counterResult}`)

      const warnings = [
        result.data.promotionError
          ? `Draft-status check failed: ${result.data.promotionError}`
          : null,
        result.data.promotionFailures > 0
          ? `${result.data.promotionFailures} Shopify-published drafts could not be reflected.`
          : null,
        result.data.missingShopifyDrafts > 0
          ? result.data.missingShopifyDrafts === 1
            ? '1 Loupe draft is missing from Shopify. Its SKU remains reserved; open and Save the draft to recreate it with the same identity.'
            : `${result.data.missingShopifyDrafts} Loupe drafts are missing from Shopify. Their SKUs remain reserved; open and Save each draft to recreate it with the same identity.`
          : null,
        result.data.skuCounters.unknownPrefixes.length > 0
          ? `Unknown Shopify SKU prefixes were not created: ${result.data.skuCounters.unknownPrefixes
              .map((row) => row.prefix)
              .join(', ')}.`
          : null,
        result.data.skuCounters.unparseableSkus > 0
          ? `${result.data.skuCounters.unparseableSkus} Shopify SKUs could not be parsed and were ignored.`
          : null,
      ].filter((warning): warning is string => warning !== null)
      setDetail(warnings.length > 0 ? warnings.join('\n') : null)
    } else {
      setFeedback(result.error)
      setDetail(result.detail)
    }
  }

  return (
    <div className="grid min-h-dvh grid-cols-[216px_1fr] gap-[18px] p-[18px]">
      <Sidebar
        operator={operator}
        attentionCount={snapshot.attentionCount}
        active="tracking"
      />

      <main className="flex min-w-0 flex-col gap-3.5">
        <header className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-[26px] font-medium tracking-[-0.025em]">Tracking</h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {new Date(snapshot.generatedAt).toLocaleDateString('en-GB', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                timeZone: 'Asia/Kolkata',
              })}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void reconcile()}
              title="Checks Shopify product drift and safely raises future per-category SKU counters"
              className="rounded-pill bg-ink px-4 py-2 text-[11px] font-medium text-white disabled:opacity-40"
            >
              {busy === 'reconcile' ? 'Reconciling…' : 'Full reconciliation'}
            </button>
            <Stat value={snapshot.uploadedToday} label="photos uploaded" />
            <Stat value={snapshot.listedToday} label="products listed" />
            <Stat value={snapshot.attentionCount} label="need attention" attention />
            <Stat value={snapshot.inQueueCount} label="queue items" dark />
          </div>
        </header>

        {feedback ? (
          <div
            role="status"
            className="rounded-panel bg-surface px-4 py-3 text-[12px] text-ink-soft"
          >
            {feedback}
            {detail ? (
              <details className="mt-1.5 text-[10.5px] text-muted-foreground">
                <summary className="cursor-pointer">Details</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{detail}</pre>
              </details>
            ) : null}
          </div>
        ) : null}

        <section className="flex min-h-0 flex-1 flex-col rounded-card bg-surface p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-pill bg-chip p-[3px]" aria-label="Tracking view">
              {([
                ['attention', 'Needs attention'],
                ['draft', 'Drafts'],
                ['progress', 'In progress'],
                ['all', 'All'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filters.view === value}
                  onClick={() => setFilters((current) => ({ ...current, view: value }))}
                  className={cn(
                    'rounded-pill px-3.5 py-1.5 text-[11.5px]',
                    filters.view === value
                      ? 'bg-ink font-medium text-white'
                      : 'text-muted-foreground',
                  )}
                >
                  {label}
                  {value !== 'all' ? (
                    <span className="ml-1.5 rounded-pill bg-black/10 px-1.5 text-[10px]">
                      {snapshot.rows.filter((row) => row.group === value).length}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="ml-auto flex flex-wrap gap-1.5">
              <FilterSelect
                label="Status"
                value={filters.status}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    status: value as TrackingFilters['status'],
                  }))
                }
                options={[
                  ['any', 'Any status'],
                  ['failed', 'Failed'],
                  ['stalled', 'Stalled'],
                  ['running', 'Running'],
                  ['mismatch', 'Mismatch'],
                  ['complete', 'Complete'],
                ]}
              />
              <FilterSelect
                label="Error"
                value={filters.error}
                onChange={(value) => setFilters((current) => ({ ...current, error: value }))}
                options={[
                  ['', 'Any error'],
                  ...errorOptions.map((code) => [code, code.replaceAll('_', ' ')] as const),
                ]}
              />
              <FilterSelect
                label="Age"
                value={filters.age}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    age: value as TrackingFilters['age'],
                  }))
                }
                options={[
                  ['any', 'Any age'],
                  ['1h', 'Over 1 hour'],
                  ['24h', 'Over 24 hours'],
                ]}
              />
              <label>
                <span className="sr-only">Search filename or reason</span>
                <input
                  type="search"
                  value={filters.search}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, search: event.target.value }))
                  }
                  placeholder="Search filename"
                  className="w-[158px] rounded-pill bg-chip px-3.5 py-[7px] text-[11.5px] outline-none"
                />
              </label>
            </div>
          </div>

          <div className="loupe-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {rows.map((row) => (
              <TrackingItem
                key={row.rowId}
                row={row}
                now={now}
                busy={busy}
                onRetry={() =>
                  void update(
                    `retry:${row.entityId}`,
                    () => retryIntakeAction(row.entityId),
                    `${row.label} returned to the enhancement queue.`,
                  )
                }
                onSkip={() =>
                  void update(
                    `skip:${row.entityId}`,
                    () => skipIntakeAction(row.entityId),
                    `${row.label} is on hold.`,
                  )
                }
                onResume={() =>
                  void update(
                    `resume:${row.entityId}`,
                    () => resumeIntakeAction(row.entityId),
                    `${row.label} is back in the enhancement queue.`,
                  )
                }
                onDiscard={() => {
                  // Irreversible and off-site: it deletes the images and moves
                  // the file out of RAW. Worth one deliberate confirmation.
                  if (
                    !window.confirm(
                      `Discard ${row.label}?\n\nIts images will be deleted and the file moved out of the RAW folder. This cannot be undone.`,
                    )
                  ) {
                    return
                  }
                  void update(
                    `discard:${row.entityId}`,
                    () => discardIntakeAction(row.entityId),
                    `${row.label} was discarded and moved out of RAW.`,
                  )
                }}
                onDuplicate={(decision) =>
                  row.duplicate
                    ? void update(
                        `duplicate:${row.entityId}`,
                        () =>
                          reviewDuplicateAction({
                            intakeFileId: row.entityId,
                            matchIntakeFileId: row.duplicate!.matchIntakeFileId,
                            decision,
                          }),
                        decision === 'duplicate'
                          ? `${row.label} was marked duplicate.`
                          : 'The pair was dismissed and will not be warned again.',
                      )
                    : undefined
                }
              />
            ))}
            {rows.length === 0 ? (
              <p className="py-12 text-center text-[12px] text-muted-foreground">
                No work matches these filters.
              </p>
            ) : null}
          </div>

          <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11px] text-muted-foreground">
            <span>
              Showing <b className="text-ink">{rows.length}</b> of {snapshot.rows.length} tracked
              items
            </span>
            <span className="ml-auto">
              {snapshot.latestReconciliation
                ? snapshot.latestReconciliation.status === 'completed'
                  ? `Shopify: ${snapshot.latestReconciliation.matchedProducts}/${snapshot.latestReconciliation.totalProducts} matched · ${snapshot.latestReconciliation.issueCount} issues`
                  : `Shopify check ${snapshot.latestReconciliation.status}`
                : 'Shopify has not been checked yet'}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void update('refresh', refreshTrackingAction, 'Tracking refreshed.')
              }
              className="rounded-pill bg-chip px-3 py-1.5 text-ink-soft disabled:opacity-40"
            >
              Refresh
            </button>
          </footer>
        </section>
      </main>
    </div>
  )
}

function TrackingItem({
  row,
  now,
  busy,
  onRetry,
  onSkip,
  onResume,
  onDiscard,
  onDuplicate,
}: {
  row: TrackingRow
  now: number
  busy: string | null
  onRetry: () => void
  onSkip: () => void
  onResume: () => void
  onDiscard: () => void
  onDuplicate: (decision: 'dismissed' | 'duplicate') => void
}) {
  return (
    <article className="rounded-panel border border-[#efefef] p-3.5 focus-within:border-ink">
      <div className="flex items-start gap-3.5">
        <div className="relative size-[52px] shrink-0 overflow-hidden rounded-[13px] bg-chip">
          {row.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived private R2 URL.
            <img src={row.thumb.url} alt="" className="size-full object-cover" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[12px] font-medium">{row.label}</span>
            <Status tone={row.tone}>{row.statusLabel}</Status>
            {/*
              What this photograph actually cost: the cached description plus
              every generated image, redos included. Provider-reported only
              (D5/D35) — never derived from a price table. Absent, not zero,
              when nothing has been billed yet.
            */}
            {row.costUsd !== null ? (
              <span
                className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                title="Description + image generation for this photograph, as billed by the provider"
              >
                ${row.costUsd.toFixed(4)}
              </span>
            ) : null}
            <span
              className={cn(
                'shrink-0 text-[11px] text-muted-foreground',
                row.costUsd === null && 'ml-auto',
              )}
            >
              {relativeAge(row.occurredAt, now)}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{row.reason}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {row.canRetry ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={onRetry}
                className="rounded-pill bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
              >
                {busy === `retry:${row.entityId}` ? 'Retrying…' : 'Retry'}
              </button>
            ) : null}
            {row.consoleHref ? (
              <Link
                href={row.consoleHref}
                className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink-soft"
              >
                Open in console
              </Link>
            ) : null}
            {row.driveHref ? (
              <a
                href={row.driveHref}
                target="_blank"
                rel="noreferrer"
                className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink-soft"
              >
                Open in Drive
              </a>
            ) : null}
            {row.canSkip ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={onSkip}
                className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink-soft disabled:opacity-40"
              >
                Skip
              </button>
            ) : null}
            {row.canResume ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={onResume}
                className="rounded-pill bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
              >
                {busy === `resume:${row.entityId}` ? 'Resuming…' : 'Resume'}
              </button>
            ) : null}
            {row.canDiscard ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={onDiscard}
                title="Deletes the images and moves the file out of the RAW folder"
                className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink-soft disabled:opacity-40"
              >
                {busy === `discard:${row.entityId}` ? 'Discarding…' : 'Discard'}
              </button>
            ) : null}
            {row.duplicate ? (
              <>
                {row.duplicate.canMarkDuplicate ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => onDuplicate('duplicate')}
                    className="rounded-pill bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
                  >
                    Mark this duplicate
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onDuplicate('dismissed')}
                  className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink-soft disabled:opacity-40"
                >
                  Not a duplicate
                </button>
              </>
            ) : null}
            <details className="ml-auto text-[11px]">
              <summary className="cursor-pointer rounded-pill bg-chip px-3 py-1.5 text-ink-soft">
                Details
              </summary>
              <div className="mt-3 border-t border-line pt-3">
                {row.events.length > 0 ? (
                  <ol className="space-y-1.5">
                    {row.events.map((event) => (
                      <li key={event.id} className="grid grid-cols-[84px_1fr] gap-2">
                        <time className="font-mono text-[10px] text-muted-foreground">
                          {new Date(event.createdAt).toLocaleString('en-GB', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'Asia/Kolkata',
                          })}
                        </time>
                        <div>
                          <p className="text-[11px] text-ink-soft">
                            {event.event.replaceAll('.', ' ')}
                            {event.actor ? ` · ${event.actor}` : ''}
                          </p>
                          <pre className="mt-0.5 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[9.5px] text-muted-foreground">
                            {event.detail}
                          </pre>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-muted-foreground">No event history is available.</p>
                )}
                {row.rawDetail ? (
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-field bg-chip p-2.5 font-mono text-[9.5px] text-muted-foreground">
                    {row.rawDetail}
                  </pre>
                ) : null}
              </div>
            </details>
          </div>
        </div>
      </div>
    </article>
  )
}

function Status({
  tone,
  children,
}: {
  tone: TrackingRow['tone']
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-pill px-2.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em]',
        tone === 'failed' || tone === 'mismatch'
          ? 'bg-[#faf2e4] text-amber'
          : tone === 'running'
            ? 'bg-ink text-white'
            : 'bg-chip text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function Stat({
  value,
  label,
  attention,
  dark,
}: {
  value: number
  label: string
  attention?: boolean
  dark?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-pill px-4 py-2',
        dark ? 'bg-ink text-white' : 'bg-surface',
      )}
    >
      {attention ? <span className="size-1.5 rounded-full bg-amber" /> : null}
      <b className="text-[15px] font-semibold">{value}</b>
      <span className={cn('text-[11px]', dark ? 'text-white/60' : 'text-muted-foreground')}>
        {label}
      </span>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly (readonly [string, string])[]
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-pill bg-chip px-3 py-[7px] text-[11.5px] text-ink-soft outline-none"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue || 'any'} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}
