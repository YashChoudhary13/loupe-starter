import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/link', () => ({ default: ({ children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement('a', rest, children as string) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/qc/123' }))
vi.mock('@/components/live/LiveActivity', () => ({ LiveActivity: () => createElement('div', { 'data-live': true }) }))
import { AppShell } from '@/components/shell/AppShell'
import type { Operator } from '@/lib/auth/authorize'

const operator = { id: 'op', email: 'checker@example.test', name: 'Checker', role: 'operator' } as Operator

describe('workspace frame on phones and desktops', () => {
  it('renders a phone top bar plus a desktop-only aside, and keeps the section as a sized grid item', () => {
    const html = renderToString(createElement(AppShell, { operator, initialAttentionCount: 3, initialCollapsed: false, children: createElement('section', { className: 'h-full' }, 'content') })).replace(/<!-- -->/g, '')
    expect(html).toContain('<header class="flex shrink-0 items-center gap-2 md:hidden">')
    expect(html).toContain('<aside class="hidden min-h-0 flex-col gap-[22px] overflow-hidden px-1 pt-2 md:flex">')
    expect(html).toMatch(/class="flex h-dvh flex-col gap-3 overflow-hidden p-3 md:grid/)
    expect(html).toContain('grid-rows-[minmax(0,1fr)] md:contents')
    // Both navs list every section; the current one is marked in both.
    expect((html.match(/href="\/qc"/g) ?? []).length).toBe(2)
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(2)
    expect((html.match(/href="\/labels"/g) ?? []).length).toBe(2)
    // Attention badge appears in both navs; the live poller is mounted once (inside the aside).
    expect((html.match(/>3</g) ?? []).length).toBe(2)
    expect((html.match(/data-live/g) ?? []).length).toBe(1)
    expect(html).toContain('whitespace-nowrap')
  })
})
