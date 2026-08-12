'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

import type { Operator } from '@/lib/auth/authorize'
import { LIVE_ACTIVITY_EVENT, type LiveActivityUpdate } from '@/lib/live/types'
import { cn } from '@/lib/utils'

import { LiveActivity } from '@/components/live/LiveActivity'

/**
 * Shared authenticated navigation for the operator workspace.
 *
 * Rendered once by the (shell) layout, so it survives section switches instead
 * of remounting — which also keeps the LiveActivity poller and its cursor
 * alive across navigation. The attention badge starts from the server-rendered
 * count and then follows the live heartbeat.
 */
export function Sidebar({
  operator,
  initialAttentionCount,
  collapsed,
  onToggle,
}: {
  operator: Operator
  initialAttentionCount: number
  collapsed: boolean
  onToggle: () => void
}) {
  const pathname = usePathname()
  const [attentionCount, setAttentionCount] = useState(initialAttentionCount)

  useEffect(() => {
    const onLive = (event: Event) => {
      const update = (event as CustomEvent<LiveActivityUpdate>).detail
      if (update?.snapshot) setAttentionCount(update.snapshot.attention)
    }
    window.addEventListener(LIVE_ACTIVITY_EVENT, onLive)
    return () => window.removeEventListener(LIVE_ACTIVITY_EVENT, onLive)
  }, [])

  const active: 'console' | 'tracking' | 'prompts' | 'upload' = pathname.startsWith('/tracking')
    ? 'tracking'
    : pathname.startsWith('/prompts')
      ? 'prompts'
      : pathname.startsWith('/upload')
        ? 'upload'
        : 'console'

  return (
    <aside className="flex min-h-0 flex-col gap-[22px] overflow-hidden px-1 pt-2">
      <div className={cn('flex items-center gap-2.5', collapsed ? 'flex-col px-0' : 'px-3')}>
        <div className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-ink text-[14px] font-semibold text-white">
          L
        </div>
        {collapsed ? null : (
          <span className="font-medium tracking-[-0.01em]">Loupe</span>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full bg-chip text-ink-soft transition-colors hover:bg-[#e6e6e6]',
            collapsed ? '' : 'ml-auto',
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className={cn('size-3.5 transition-transform duration-200', collapsed && 'rotate-180')}
            aria-hidden
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      </div>

      <nav className="flex flex-col gap-1">
        {collapsed ? null : (
          <div className="mb-2 px-3.5 text-[10px] uppercase tracking-[0.13em] text-muted-foreground">
            Workspace
          </div>
        )}

        <NavItem
          href="/console"
          label="Console"
          active={active === 'console'}
          collapsed={collapsed}
          icon={<SearchIcon />}
        />
        <NavItem
          href="/upload"
          label="Upload"
          active={active === 'upload'}
          collapsed={collapsed}
          icon={<UploadIcon />}
        />
        <NavItem
          href="/tracking"
          label="Tracking"
          active={active === 'tracking'}
          collapsed={collapsed}
          icon={<AlertIcon />}
          badge={attentionCount > 0 ? attentionCount : null}
        />
        <NavItem
          href="/prompts"
          label="Prompts"
          active={active === 'prompts'}
          collapsed={collapsed}
          icon={<ListIcon />}
        />
      </nav>

      <LiveActivity compact={collapsed} />

      <form action="/api/auth/signout" method="post" className="mt-auto">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 pb-1">
            <div
              title={operator.email}
              className="size-[30px] rounded-full bg-gradient-to-br from-[#c9c9cf] to-[#8e8e93]"
            />
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="grid size-7 place-items-center rounded-full bg-chip text-[12px] text-ink-soft transition-colors hover:bg-[#ebebeb]"
            >
              ⏻
            </button>
          </div>
        ) : (
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
        )}
      </form>
    </aside>
  )
}

function NavItem({
  href,
  label,
  active,
  collapsed,
  icon,
  badge = null,
}: {
  href: '/console' | '/tracking' | '/prompts' | '/upload'
  label: string
  active: boolean
  collapsed: boolean
  icon: React.ReactNode
  badge?: number | null
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-3 rounded-pill font-medium transition-colors duration-150',
        collapsed ? 'justify-center px-0 py-2.5' : 'px-4 py-2.5',
        active ? 'bg-ink text-white' : 'text-ink-soft hover:bg-chip',
      )}
    >
      {icon}
      {collapsed ? null : label}
      {badge !== null ? (
        collapsed ? (
          <span
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-amber"
            aria-label={`${badge} needing attention`}
          />
        ) : (
          <span
            className={cn(
              'ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-[9px] px-1 text-[10px] font-semibold',
              active ? 'bg-white text-ink' : 'bg-amber text-white',
            )}
          >
            {badge}
          </span>
        )
      ) : null}
    </Link>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 shrink-0 opacity-85" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 shrink-0 opacity-85" aria-hidden>
      <path d="M12 8v5M12 16.5v.5" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 shrink-0 opacity-85" aria-hidden>
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 shrink-0 opacity-85" aria-hidden>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  )
}
