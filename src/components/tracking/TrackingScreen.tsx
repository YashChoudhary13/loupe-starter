'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  dismissReconciliationIssueAction,
  resolveWebhookAlertAction,
  discardIntakeAction,
  refreshTrackingAction,
  resumeIntakeAction,
  resumeProviderPausedIntakeAction,
  retryIntakeAction,
  reviewDuplicateAction,
  skipIntakeAction,
} from '@/app/(shell)/tracking/actions'
import {
  LIVE_ACTIVITY_EVENT,
  shouldRefreshTracking,
  type LiveActivityUpdate,
} from '@/lib/live/types'
import { filterTrackingRows, type TrackingFilters } from '@/lib/tracking/filters'
import type { TrackingRow, TrackingSnapshot } from '@/lib/tracking/types'
import { cn } from '@/lib/utils'

import { stageIndexFor, TrackingItem } from './TrackingItem'


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

/**
 * D121 — Needs attention reads as a triaged list, not a wall. First matching
 * section wins; order is the order a human should deal with them.
 */
const ATTENTION_SECTIONS = [
  {
    key: 'provider',
    title: 'Provider paused',
    hint: 'The model account needs credits. Nothing is wrong with these photographs — top up, then resume.',
    matches: (row: TrackingRow) => row.canResumeEnhancement,
  },
  {
    key: 'failed',
    title: 'Failures',
    hint: 'Enhancement or publishing failed after its retries. Each row says why.',
    matches: (row: TrackingRow) => row.tone === 'failed',
  },
  {
    key: 'duplicates',
    title: 'Possible duplicates',
    hint: 'Two photographs look alike. Deciding never blocks publishing.',
    matches: (row: TrackingRow) => row.duplicate !== null,
  },
  {
    key: 'stalled',
    title: 'Stalled',
    hint: 'Nothing failed — this work has just been waiting on a person for a while.',
    matches: (row: TrackingRow) => row.tone === 'stalled',
  },
  {
    key: 'hold',
    title: 'On hold',
    hint: 'Deliberately skipped photographs, waiting for you to resume or discard them.',
    matches: (row: TrackingRow) => row.canResume,
  },
  {
    key: 'shopify',
    title: 'Shopify drift',
    hint: 'The live store differs from what Loupe published. Loupe records drift; it never repairs Shopify on its own.',
    matches: (row: TrackingRow) =>
      row.kind === 'reconciliation' || row.rowId.startsWith('webhook-alert:'),
  },
  { key: 'other', title: 'Other', hint: '', matches: () => true },
] as const

function sectionRows(rows: readonly TrackingRow[]) {
  const remaining = [...rows]
  return ATTENTION_SECTIONS.map((section) => {
    const matched: TrackingRow[] = []
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (section.matches(remaining[index])) matched.unshift(...remaining.splice(index, 1))
    }
    return { ...section, rows: matched }
  }).filter((section) => section.rows.length > 0)
}

export function TrackingScreen({
  initialSnapshot,
}: {
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

  const renderRow = (row: TrackingRow) => (
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
                onResumeEnhancement={() =>
                  void update(
                    `resume-enhancement:${row.entityId}`,
                    () => resumeProviderPausedIntakeAction(row.entityId),
                    `${row.label} was released and enhancement resumed.`,
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
                onDismiss={() => {
                  // The finding id lives in rowId; `entityId` carries the run or
                  // draft the event trail hangs off. `webhook-alert:` rows are
                  // live push findings (D102), `reconciliation:` the nightly ones.
                  const findingId = Number(row.rowId.split(':')[1])
                  if (!Number.isFinite(findingId)) return
                  if (row.rowId.startsWith('webhook-alert:')) {
                    void update(
                      `dismiss:${row.rowId}`,
                      () => resolveWebhookAlertAction({ alertId: findingId }),
                      'Resolved. It returns if Shopify reports the product drifting again.',
                    )
                    return
                  }
                  void update(
                    `dismiss:${row.rowId}`,
                    () => dismissReconciliationIssueAction({ issueId: findingId }),
                    'Marked correct. It will stay hidden unless the value changes again.',
                  )
                }}
              />
  )

  return (
    <main className="loupe-scroll flex min-h-0 min-w-0 flex-col gap-3.5 overflow-y-auto pr-1">
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
            <Link
              href="/workflows"
              title="Runs in Workflows with a live step-by-step view"
              className="rounded-pill bg-ink px-4 py-2 text-[11px] font-medium text-white"
            >
              Full reconciliation ↗
            </Link>
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
                ['progress', 'In progress'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filters.view === value}
                  onClick={() => setFilters((current) => ({ ...current, view: value }))}
                  className={cn(
                    'rounded-pill px-3.5 py-1.5 text-[11.5px] transition-colors',
                    filters.view === value
                      ? 'bg-ink font-medium text-white'
                      : 'text-muted-foreground hover:text-ink-soft',
                  )}
                >
                  {label}
                  <span className="ml-1.5 rounded-pill bg-black/10 px-1.5 text-[10px]">
                    {snapshot.rows.filter((row) => row.group === value).length}
                  </span>
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
            {filters.view === 'progress' && rows.length > 0 ? (
              <div className="mb-1 flex flex-wrap gap-2" aria-label="Pipeline stage counts">
                {([
                  ['Queued', 0],
                  ['Describer', 1],
                  ['Image model', 2],
                  ['Finished', 4],
                ] as const).map(([label, index]) => {
                  const count = rows.filter(
                    (row) => stageIndexFor(row.statusLabel) === index,
                  ).length
                  return (
                    <span
                      key={label}
                      className={cn(
                        'rounded-pill px-3 py-1.5 text-[11px]',
                        count > 0 ? 'bg-chip text-ink' : 'bg-chip/60 text-muted-foreground',
                      )}
                    >
                      <b className="font-semibold">{count}</b> {label.toLowerCase()}
                    </span>
                  )
                })}
                {rows.some((row) => row.kind === 'redo') ? (
                  <span className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink">
                    <b className="font-semibold">
                      {rows.filter((row) => row.kind === 'redo').length}
                    </b>{' '}
                    redo
                  </span>
                ) : null}
              </div>
            ) : null}

            {filters.view === 'attention' ? (
              sectionRows(rows).map((section) => (
                <section key={section.key} aria-label={section.title}>
                  <div className="mb-1.5 mt-2 flex items-baseline gap-2 first:mt-0">
                    <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em]">
                      {section.title}
                    </h2>
                    <span className="rounded-pill bg-chip px-1.5 text-[10px] text-muted-foreground">
                      {section.rows.length}
                    </span>
                    {section.hint ? (
                      <span className="text-[10.5px] text-muted-foreground">{section.hint}</span>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2">{section.rows.map(renderRow)}</div>
                </section>
              ))
            ) : (
              rows.map(renderRow)
            )}

            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <span className="text-[20px]">
                  {filters.view === 'attention' ? '✓' : '·'}
                </span>
                <p className="text-[12.5px] font-medium text-ink-soft">
                  {filters.view === 'attention'
                    ? snapshot.attentionCount === 0
                      ? 'Nothing needs attention'
                      : 'No attention items match these filters'
                    : 'Nothing is running right now'}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {filters.view === 'attention'
                    ? snapshot.attentionCount === 0
                      ? 'Failures, stalls, duplicates and Shopify drift will appear here the moment they happen.'
                      : 'Clear a filter above to see them.'
                    : 'New uploads join the queue within a minute and move through Describe, Render and Check here.'}
                </p>
              </div>
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
