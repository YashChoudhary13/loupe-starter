import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/link', () => ({ default: ({ children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement('a', rest, children as string) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/qc/123' }))
vi.mock('@/components/live/LiveActivity', () => ({ LiveActivity: () => createElement('div', { 'data-live': true }) }))
import { AppShell } from '@/components/shell/AppShell'
import type { Operator } from '@/lib/auth/authorize'
import type { Face } from '@/lib/faces/faces'

const operator = { id: 'op', email: 'checker@example.test', name: 'Checker', role: 'operator' } as Operator
const render = (face: Face | null) => renderToString(createElement(AppShell, { operator, face, initialAttentionCount: 0, initialCollapsed: false }, createElement('section', null, 'content'))).replace(/<!-- -->/g, '')

describe('the shell on one face', () => {
  it("lists only that face's screens, names the face, and offers the other three as Apps", () => {
    const html = render('qc')
    expect(html).toContain('href="/qc"'); expect(html).toContain('href="/labels"')
    for (const href of ['href="/console"', 'href="/dispatch"', 'href="/home"', 'href="/tracking"']) expect(html).not.toContain(href)
    expect(html).toContain('<span class="font-medium tracking-[-0.01em]">Order QC</span>')
    for (const host of ['qimati-eng.site', 'ship.qimati-eng.site', 'loupe.qimati-eng.site']) expect(html).toContain(`href="https://${host}/"`)
    expect(html).not.toContain('href="https://qc.qimati-eng.site/"')
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(2)
  })
  it('without a face (a dev machine) lists every screen and no Apps switcher', () => {
    const html = render(null)
    for (const href of ['href="/home"', 'href="/console"', 'href="/qc"', 'href="/dispatch"']) expect(html).toContain(href)
    expect(html).not.toContain('https://ship.qimati-eng.site/')
    expect(html).toContain('<span class="font-medium tracking-[-0.01em]">Loupe</span>')
  })
})
