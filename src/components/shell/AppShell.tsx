'use client'

import { useState, type ReactNode } from 'react'

import type { Operator } from '@/lib/auth/authorize'

import { Sidebar } from '@/components/console/Sidebar'

const COLLAPSE_COOKIE = 'loupe_nav_collapsed'
const EXPANDED_PX = 216
const COLLAPSED_PX = 68

/**
 * The persistent workspace frame: one grid, one sidebar, section content in
 * the second column. Lives in the (shell) layout so navigation between
 * Console, Tracking and Prompts swaps only the content column.
 *
 * Below the `md` breakpoint (phones, QC on a handset) the frame becomes a
 * column: a compact top bar from Sidebar, then the section filling the rest.
 * The content wrapper is `md:contents`, so on desktop the section is still a
 * direct grid item exactly as before; on mobile it is a single-cell grid so
 * `h-full` / `min-h-0 flex-1` sections size the same way they do on desktop.
 *
 * Collapse state is a cookie rather than localStorage so the server renders
 * the correct width on first paint — no hydration snap.
 */
export function AppShell({
  operator,
  initialAttentionCount,
  initialCollapsed,
  children,
}: {
  operator: Operator
  initialAttentionCount: number
  initialCollapsed: boolean
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)

  const toggle = () =>
    setCollapsed((current) => {
      const next = !current
      document.cookie = `${COLLAPSE_COOKIE}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`
      return next
    })

  return (
    <div
      className="flex h-dvh flex-col gap-3 overflow-hidden p-3 md:grid md:gap-[18px] md:p-[18px] md:transition-[grid-template-columns] md:duration-300 md:ease-in-out"
      style={{
        gridTemplateColumns: `${collapsed ? COLLAPSED_PX : EXPANDED_PX}px minmax(0, 1fr)`,
      }}
    >
      <Sidebar
        operator={operator}
        initialAttentionCount={initialAttentionCount}
        collapsed={collapsed}
        onToggle={toggle}
      />
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] md:contents">{children}</div>
    </div>
  )
}
