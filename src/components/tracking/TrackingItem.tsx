'use client'

import Link from 'next/link'

import type { TrackingRow } from '@/lib/tracking/types'
import { cn } from '@/lib/utils'

/**
 * D121 — one tracked unit of work. Extracted from TrackingScreen and given the
 * information the operator actually asks for at a glance: which models ran,
 * whether the render passed verification, and — for running work — where in
 * the pipeline the photograph currently is.
 */

export function relativeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** "google/gemini-3.5-flash" → "gemini-3.5-flash": the provider is noise here. */
function modelShort(model: string): string {
  const slash = model.indexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

const PIPELINE_STEPS = ['Queued', 'Describe', 'Render', 'Check'] as const

/** Which pipeline step a running photograph is on, from its status label. */
export function stageIndexFor(statusLabel: string): number | null {
  if (statusLabel === 'Queued') return 0
  if (statusLabel === 'Describer working') return 1
  if (statusLabel === 'Image model working') return 2
  if (statusLabel.startsWith('Enhanced')) return 4
  return null
}

function StageDots({ statusLabel }: { statusLabel: string }) {
  const index = stageIndexFor(statusLabel)
  if (index === null) return null
  return (
    <div className="mt-1.5 flex items-center gap-1" aria-label={`Pipeline stage: ${statusLabel}`}>
      {PIPELINE_STEPS.map((step, position) => (
        <span key={step} className="flex items-center gap-1">
          <span
            className={cn(
              'size-1.5 rounded-full',
              position < index
                ? 'bg-ink'
                : position === index
                  ? 'animate-pulse bg-amber'
                  : 'bg-black/15',
            )}
          />
          <span
            className={cn(
              'text-[9.5px]',
              position === index ? 'font-medium text-ink' : 'text-muted-foreground',
            )}
          >
            {step}
          </span>
          {position < PIPELINE_STEPS.length - 1 ? (
            <span className="h-px w-3 bg-black/10" aria-hidden="true" />
          ) : null}
        </span>
      ))}
    </div>
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

function VerdictChip({ verdict }: { verdict: NonNullable<TrackingRow['checkVerdict']> }) {
  if (verdict === 'skipped') return null
  return (
    <span
      title={
        verdict === 'pass'
          ? 'The render was verified against the source photograph and matched.'
          : 'Verification found differences from the source photograph even after a corrected retry — review before publishing.'
      }
      className={cn(
        'shrink-0 rounded-pill px-2 py-0.5 text-[9.5px] font-semibold',
        verdict === 'pass' ? 'bg-chip text-ink-soft' : 'bg-[#faf2e4] text-amber',
      )}
    >
      {verdict === 'pass' ? '✓ verified' : '⚠ check failed'}
    </span>
  )
}

export function TrackingItem({
  row,
  now,
  busy,
  onRetry,
  onSkip,
  onResume,
  onResumeEnhancement,
  onDiscard,
  onDuplicate,
  onDismiss,
}: {
  row: TrackingRow
  now: number
  busy: string | null
  onRetry: () => void
  onSkip: () => void
  onResume: () => void
  onResumeEnhancement: () => void
  onDiscard: () => void
  onDuplicate: (decision: 'dismissed' | 'duplicate') => void
  onDismiss: () => void
}) {
  const models = [
    row.describerModel ? (['describe', row.describerModel] as const) : null,
    row.imageModel ? (['render', row.imageModel] as const) : null,
  ].filter((entry): entry is readonly ['describe' | 'render', string] => entry !== null)

  return (
    <article className="rounded-panel border border-[#efefef] p-3.5 transition-colors focus-within:border-ink hover:border-[#dcdcdc]">
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
            {row.checkVerdict ? <VerdictChip verdict={row.checkVerdict} /> : null}
            {/*
              What this row actually cost: the cached description plus every
              generated image, redos included — provider-reported only
              (D5/D35). Absent, not zero, when nothing has been billed yet.
            */}
            {row.costUsd !== null ? (
              <span
                className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                title={
                  row.kind === 'draft'
                    ? 'Description + image generation across every photograph in this product, as billed by the provider'
                    : 'Description + image generation for this photograph, as billed by the provider'
                }
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

          {row.tone === 'running' || row.statusLabel === 'Queued' ? (
            <StageDots statusLabel={row.statusLabel} />
          ) : null}

          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{row.reason}</p>

          {models.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {models.map(([stage, model]) => (
                <span
                  key={stage}
                  title={model}
                  className="rounded-pill bg-chip px-2 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                >
                  {stage} · {modelShort(model)}
                </span>
              ))}
            </div>
          ) : null}

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
            {row.canResumeEnhancement ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={onResumeEnhancement}
                className="rounded-pill bg-ink px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
              >
                {busy === `resume-enhancement:${row.entityId}`
                  ? 'Resuming…'
                  : 'Resume enhancement'}
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
            {row.canDismiss ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={onDismiss}
                title="Records that this difference is correct. It stays hidden across future checks, and returns only if the value changes again."
                className="rounded-pill bg-chip px-3 py-1.5 text-[11px] text-ink-soft disabled:opacity-40"
              >
                {busy === `dismiss:${row.rowId}` ? 'Dismissing…' : 'This is correct'}
              </button>
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
