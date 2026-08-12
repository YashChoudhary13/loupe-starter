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
      className="grid h-dvh gap-[18px] overflow-hidden p-[18px] transition-[grid-template-columns] duration-300 ease-in-out"
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
      {children}
    </div>
  )
}
