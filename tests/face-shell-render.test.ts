import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/link', () => ({ default: ({ children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement('a', rest, children as string) }))
const nav = vi.hoisted(() => ({ path: '/qc/123' }))
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }))
vi.mock('@/components/live/LiveActivity', () => ({ LiveActivity: () => createElement('div', { 'data-live': true }) }))
import { AppShell } from '@/components/shell/AppShell'
import type { Operator } from '@/lib/auth/authorize'
import type { Face } from '@/lib/faces/faces'

const operator = { id: 'op', email: 'checker@example.test', name: 'Checker', role: 'operator' } as Operator
const render = (face: Face | null) => renderToString(createElement(AppShell, { operator, face, initialAttentionCount: 0, initialCollapsed: false }, createElement('section', null, 'content'))).replace(/<!-- -->/g, '')

beforeEach(() => { nav.path = '/qc/123' })
describe('the shell on one face', () => {
  it("lists only that face's screens, names the face, and offers the other three as Apps", () => {
    const html = render('qc')
    expect(html).toContain('href="/qc"'); expect(html).toContain('href="/labels"')
    for (const href of ['href="/tracking"', 'href="/dispatch/print"', 'href="/enhance"']) expect(html).not.toContain(href)
    expect(html).toContain('<span class="font-medium tracking-[-0.01em]">Order QC</span>')
    // The other faces are links inside the app, to each face's first screen: no page load, no other address (D172).
    for (const [label, href] of [['Qimati', '/home'], ['Fulfilment', '/dispatch'], ['Loupe', '/console']]) expect(html).toContain(`href="${href}" title="" aria-label="Open ${label}"`.replace(' title=""', ''))
    expect(html).not.toContain('aria-label="Open Order QC"')
    expect(html).not.toContain('https://')
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(2)
  })
  it('after a switch inside the app wears the face of the screen, not of the address it was opened on (D172)', () => {
    nav.path = '/dispatch/print'
    const html = render('qc')
    expect(html).toContain('<span class="font-medium tracking-[-0.01em]">Fulfilment</span>')
    expect(html).toContain('href="/dispatch"'); expect(html).toContain('href="/dispatch/print"')
    expect(html).not.toContain('href="/labels"')
    expect(html).toContain('aria-label="Open Order QC"'); expect(html).not.toContain('aria-label="Open Fulfilment"')
  })
  it('without a face (a dev machine) lists every screen and no Apps switcher', () => {
    const html = render(null)
    for (const href of ['href="/home"', 'href="/console"', 'href="/qc"', 'href="/dispatch"']) expect(html).toContain(href)
    expect(html).not.toContain('https://ship.qimati-eng.site/')
    expect(html).toContain('<span class="font-medium tracking-[-0.01em]">Loupe</span>')
  })
})
