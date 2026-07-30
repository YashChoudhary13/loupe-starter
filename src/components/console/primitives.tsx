import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The handful of shapes DESIGN.md names, built once.
 *
 * Pill geometry is the signature: if something interactive has square corners it
 * is wrong. Black means active and there is no third state. Amber appears once
 * per screen and only ever means "a human is needed".
 */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('rounded-[24px] bg-surface p-5', className)}>{children}</section>
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="loupe-label block">{children}</span>
}

export function StatPill({
  value,
  label,
  selected = false,
  attention = false,
  onClick,
}: {
  value: number | string
  label: string
  selected?: boolean
  attention?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-controls="console-queue"
      className={cn(
        'flex items-center gap-2.5 rounded-pill px-4 py-2 transition-colors',
        selected ? 'bg-ink text-white' : 'bg-surface hover:bg-[#e7e7e7]',
      )}
    >
      {attention ? <span className="size-1.5 rounded-full bg-amber" aria-hidden /> : null}
      <b className="text-[15px] font-semibold tracking-[-0.02em]">{value}</b>
      <span className={cn('text-[11px]', selected ? 'text-white/60' : 'text-muted-foreground')}>
        {label}
      </span>
    </button>
  )
}

export interface ChipProps {
  readonly selected?: boolean
  readonly ghost?: boolean
  readonly disabled?: boolean
  readonly title?: string
  readonly onClick?: () => void
  readonly children: ReactNode
}

export function Chip({ selected, ghost, disabled, title, onClick, children }: ChipProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'rounded-pill px-3.5 py-[7px] text-[11.5px] transition-colors',
        ghost
          ? 'border border-dashed border-[#d5d5d5] text-muted-foreground hover:text-ink-soft'
          : selected
            ? 'bg-ink font-medium text-white'
            : 'bg-chip text-ink-soft hover:bg-[#ebebeb]',
        disabled && 'cursor-not-allowed opacity-45 hover:bg-chip',
      )}
    >
      {children}
    </button>
  )
}

/**
 * The black feature card. DESIGN.md allows exactly one per screen, and in the
 * console it is the resolved `SKU · title · handle` — the last thing the
 * operator reads before the product is live.
 */
export function FeatureCard({
  eyebrow,
  headline,
  meta,
  footnote,
}: {
  eyebrow: string
  headline: string
  meta: string
  footnote?: ReactNode
}) {
  return (
    <div className="rounded-panel bg-ink px-[17px] py-[15px] text-white">
      <div className="loupe-label text-white/45">{eyebrow}</div>
      <div className="mt-1.5 text-[17px] font-semibold tracking-[-0.01em]">{headline}</div>
      <div className="mt-[3px] font-mono text-[11.5px] text-white/[0.62]">{meta}</div>
      {footnote ? <div className="mt-2 text-[11px] text-white/55">{footnote}</div> : null}
    </div>
  )
}

/**
 * An operator-facing failure. What happened, whether anything was saved, and
 * what is safe next — with the raw detail folded away for whoever debugs it
 * (DESIGN.md · Language).
 */
export function Notice({
  tone,
  title,
  children,
  detail,
}: {
  tone: 'attention' | 'plain'
  title: string
  children?: ReactNode
  detail?: string | null
}) {
  return (
    <div
      className={cn(
        'rounded-panel px-4 py-3 text-[12.5px] leading-relaxed',
        tone === 'attention' ? 'bg-[#faf4e9] text-amber' : 'bg-chip text-ink-soft',
      )}
      role={tone === 'attention' ? 'alert' : 'status'}
    >
      <div className="font-medium">{title}</div>
      {children ? <div className="mt-1">{children}</div> : null}
      {detail ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">Details</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] text-muted-foreground">
            {detail}
          </pre>
        </details>
      ) : null}
    </div>
  )
}
