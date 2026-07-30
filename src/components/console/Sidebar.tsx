'use client'

import Link from 'next/link'

import type { Operator } from '@/lib/auth/authorize'

/**
 * The nav rail from the mockup. Console is the only screen Phase 4 builds;
 * Tracking, Prompts and Reports are later phases and are shown as what they are
 * rather than as links that go nowhere — a dead nav item is worse than an
 * honest one.
 */
export function Sidebar({
  operator,
  attentionCount,
  active = 'console',
}: {
  operator: Operator
  attentionCount: number
  active?: 'console' | 'prompts'
}) {
  return (
    <aside className="flex min-h-0 flex-col gap-[26px] px-1 pt-2">
      <div className="flex items-center gap-2.5 px-3">
        <div className="grid size-[30px] place-items-center rounded-[9px] bg-ink text-[14px] font-semibold text-white">
          L
        </div>
        <span className="font-medium tracking-[-0.01em]">Loupe</span>
      </div>

      <nav className="flex flex-col gap-1">
        <div className="mb-2 px-3.5 text-[10px] uppercase tracking-[0.13em] text-muted-foreground">
          Workspace
        </div>

        <Link
          href="/console"
          className={`flex items-center gap-3 rounded-pill px-4 py-2.5 font-medium ${
            active === 'console' ? 'bg-ink text-white' : 'text-ink-soft hover:bg-chip'
          }`}
        >
          <SearchIcon />
          Console
          {attentionCount > 0 ? (
            <span className="ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-white px-1 text-[10px] font-semibold text-ink">
              {attentionCount}
            </span>
          ) : null}
        </Link>

        <span
          className="flex items-center gap-3 rounded-pill px-4 py-2.5 text-ink-soft opacity-50"
          title="Tracking is planned for Phase 6"
          aria-disabled="true"
        >
          <AlertIcon />
          Tracking
          <span className="ml-auto text-[9px] uppercase tracking-[0.08em]">Phase 6</span>
        </span>
        <Link
          href="/prompts"
          className={`flex items-center gap-3 rounded-pill px-4 py-2.5 font-medium ${
            active === 'prompts' ? 'bg-ink text-white' : 'text-ink-soft hover:bg-chip'
          }`}
        >
          <ListIcon />
          Prompts
        </Link>
      </nav>

      <form action="/api/auth/signout" method="post" className="mt-auto">
        <div className="flex items-center gap-2.5 rounded-pill bg-surface p-2.5">
          <div className="size-[30px] shrink-0 rounded-full bg-gradient-to-br from-[#c9c9cf] to-[#8e8e93]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">
              {operator.name ?? operator.email.split('@')[0]}
            </div>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">
              {operator.email}
            </div>
          </div>
          <button
            type="submit"
            title="Sign out"
            aria-label="Sign out"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-chip text-[12px] text-ink-soft transition-colors hover:bg-[#ebebeb]"
          >
            ⏻
          </button>
        </div>
      </form>
    </aside>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 opacity-85" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 opacity-85" aria-hidden>
      <path d="M12 8v5M12 16.5v.5" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 opacity-85" aria-hidden>
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  )
}
