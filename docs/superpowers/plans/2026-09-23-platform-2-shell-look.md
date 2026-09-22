# Qimati Platform — Implementation Plan, part 2 of 8 (per-face shell, palettes, nginx)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here, and Task 1's `src/lib/faces/faces.ts` is consumed below.

---

### Task 4: The shell wears the face — menu, Apps switcher, `data-face`, tab title

**Files:**
- Modify: `src/app/layout.tsx`, `src/app/(shell)/layout.tsx`, `src/components/shell/AppShell.tsx`, `src/components/console/Sidebar.tsx`, `src/app/login/page.tsx`
- Modify: `tests/app-shell-render.test.ts` (only to pass the new required `face` prop — that file is in the lint baseline; change nothing else in it)
- Test: `tests/face-shell-render.test.ts`

**Interfaces:**
- Consumes: `FACES`, `FACE_KEYS`, `faceFromHeader`, `screenAllowed`, `Face` (Task 1).
- Produces: `AppShell` and `Sidebar` take `face: Face | null`; `<html data-face="…">`; the Sidebar's `ITEMS` gains `/home`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/face-shell-render.test.ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/face-shell-render.test.ts`
Expected: FAIL — `/home` is not a nav item, `href="/console"` is rendered on the QC face, no Apps links.

- [ ] **Step 3: Sidebar — items by face, brand, Apps switcher**

In `src/components/console/Sidebar.tsx`:

Add the import `import { FACE_KEYS, FACES, screenAllowed, type Face } from '@/lib/faces/faces'`.

Extend the two unions and the list (Home first):
```ts
type SectionKey = 'home' | 'console' | 'tracking' | 'prompts' | 'models' | 'upload' | 'identify' | 'restock' | 'workflows' | 'labels' | 'qc' | 'dispatch'
type SectionHref = '/home' | '/console' | '/tracking' | '/prompts' | '/models' | '/upload' | '/identify' | '/restock' | '/workflows' | '/labels' | '/qc' | '/dispatch'

const ITEMS: readonly { key: SectionKey; href: SectionHref; label: string; icon: React.ReactNode }[] = [
  { key: 'home', href: '/home', label: 'Home', icon: <HomeIcon /> },
  { key: 'console', href: '/console', label: 'Console', icon: <SearchIcon /> },
  // … the existing ten entries, unchanged …
]
```

Add `face: Face | null` to the props (type and destructuring). Replace the whole `const active: SectionKey = …` ternary with:
```ts
  // The face's own screens only (every screen on a dev machine without FACE_DEV). The current one is the longest-prefix match.
  const items = ITEMS.filter((item) => screenAllowed(face, item.href))
  const active = items.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.key ?? items[0]?.key
  const brand = face ? FACES[face].label : 'Loupe'
  const others = face ? FACE_KEYS.filter((key) => key !== face) : []
```

Phone header: the logo box renders `{brand[0]}` instead of `L`; the `ITEMS.map(…)` becomes `items.map(…)`; after the mapped items, inside the same `<nav>`, add
```tsx
          {others.map((key) => (
            <a key={key} href={`https://${FACES[key].host}/`} aria-label={`Open ${FACES[key].label}`} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border border-chip px-3 py-2 text-[12px] font-medium text-ink-soft">
              {FACES[key].label}
            </a>
          ))}
```

Desktop aside: the logo box renders `{brand[0]}`, the brand span renders `{brand}`, the nav maps `items`. Directly after the `</nav>` of the Workspace list add the switcher:
```tsx
      {others.length > 0 ? (
        <nav aria-label="Apps" className="flex flex-col gap-1">
          {collapsed ? null : (
            <div className="mb-2 px-3.5 text-[10px] uppercase tracking-[0.13em] text-muted-foreground">Apps</div>
          )}
          {others.map((key) => (
            <a
              key={key}
              href={`https://${FACES[key].host}/`}
              title={collapsed ? FACES[key].label : undefined}
              aria-label={`Open ${FACES[key].label}`}
              className={cn('flex items-center gap-3 rounded-pill font-medium text-ink-soft transition-colors duration-150 hover:bg-chip', collapsed ? 'justify-center px-0 py-2.5' : 'px-4 py-2.5')}
            >
              <span className="grid size-4 shrink-0 place-items-center rounded-[5px] bg-chip text-[10px] font-semibold" aria-hidden>{FACES[key].label[0]}</span>
              {collapsed ? null : FACES[key].label}
            </a>
          ))}
        </nav>
      ) : null}
```
Add the icon beside the others:
```tsx
function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4 shrink-0 opacity-85" aria-hidden>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 10v9h12v-9" />
    </svg>
  )
}
```
Update the component's doc comment: "Rendered once by the (shell) layout with the face the proxy chose (D136): only that face's screens are listed, and an Apps switcher links the other three hosts."

- [ ] **Step 4: AppShell, the two layouts, the sign-in page**

`src/components/shell/AppShell.tsx`: add `import type { Face } from '@/lib/faces/faces'`, a `face: Face | null` prop, and pass `face={face}` to `<Sidebar>`.

`src/app/(shell)/layout.tsx`:
```tsx
import { cookies, headers } from 'next/headers'

import { AppShell } from '@/components/shell/AppShell'
import { requireOperator } from '@/lib/auth/authorize'
import { faceFromHeader } from '@/lib/faces/faces'
import { loadAttentionCount } from '@/lib/tracking/attention-count'

/**
 * Shared frame for every authenticated section. The layout does not re-render
 * on navigation between its children, which is exactly what keeps the sidebar
 * and the LiveActivity poller mounted across section switches.
 *
 * The face comes from the `x-face` header the proxy set from the hostname
 * (D136); nothing here trusts a value the browser could have sent.
 *
 * Authorisation note: because layouts persist across client-side navigation,
 * each page still calls `requireOperator()` itself — this call covers the
 * initial document request, the pages cover every navigation after it.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const operator = await requireOperator()
  const [attentionCount, cookieStore, headerStore] = await Promise.all([loadAttentionCount(), cookies(), headers()])
  const collapsed = cookieStore.get('loupe_nav_collapsed')?.value === '1'

  return (
    <AppShell
      operator={operator}
      face={faceFromHeader(headerStore.get('x-face'))}
      initialAttentionCount={attentionCount}
      initialCollapsed={collapsed}
    >
      {children}
    </AppShell>
  )
}
```

`src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { headers } from 'next/headers'

import { FACES, faceFromHeader } from '@/lib/faces/faces'

import './globals.css'

// DESIGN.md names Inter. `shadcn init` swapped in Geist as part of its preset —
// that is exactly the shadcn default look the same document says not to accept.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

/** The face is decided by the proxy from the hostname (D136); the tab title and the palette follow it. */
export async function generateMetadata(): Promise<Metadata> {
  const face = faceFromHeader((await headers()).get('x-face'))
  return {
    title: face ? FACES[face].label : 'Loupe',
    description: 'Qimati operations',
    // Internal tool pointed at a live store. It should never be indexed.
    robots: { index: false, follow: false },
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const face = faceFromHeader((await headers()).get('x-face'))
  return (
    <html lang="en" data-face={face ?? undefined} className={`h-full ${inter.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
```

`src/app/login/page.tsx`: import `headers` from `next/headers` and `FACES, faceFromHeader` from `@/lib/faces/faces`; inside the component, after the `redirect('/')` line, add
```ts
  const face = faceFromHeader((await headers()).get('x-face'))
  const brand = face ? FACES[face].label : 'Loupe'
```
render `{brand[0]}` in the logo box and `{brand}` in the brand span; change "is not a Loupe user." to "is not a Qimati user." and "Loupe publishes to a real Shopify store, so access is by named account." to "These tools work on a real Shopify store, so access is by named account."

`tests/app-shell-render.test.ts`: in the `createElement(AppShell, { operator, initialAttentionCount: 3, … })` call add `face: null,` after `operator,`. Nothing else changes in that file.

- [ ] **Step 5: Run the tests, typecheck, lint**

Run: `npx vitest run tests/face-shell-render.test.ts tests/app-shell-render.test.ts && npm run typecheck && npx eslint src/app/layout.tsx "src/app/(shell)/layout.tsx" src/components/shell/AppShell.tsx src/components/console/Sidebar.tsx src/app/login/page.tsx tests/face-shell-render.test.ts`
Expected: both files PASS; typecheck clean; lint clean on the listed files (the baseline error in `tests/app-shell-render.test.ts` is not in this list and stays as it was).

- [ ] **Step 6: Commit**

```bash
git add src/app/layout.tsx "src/app/(shell)/layout.tsx" src/components/shell/AppShell.tsx src/components/console/Sidebar.tsx src/app/login/page.tsx tests/app-shell-render.test.ts tests/face-shell-render.test.ts
git commit -m "feat(platform): the shell wears the face — its own menu, an Apps switcher, data-face on html, the face's name in the tab"
```

---

### Task 5: One palette per face, four server names in nginx

**Files:**
- Modify: `src/app/globals.css`, `deploy/loupe.nginx.conf`
- Test: `tests/face-theme.test.ts`

**Interfaces:**
- Produces: `--face-accent` / `--face-accent-2` tokens (Tailwind `bg-face-accent`, `text-face-accent-2`, …) with Loupe defaults; three `:root[data-face="…"]` override blocks.

- [ ] **Step 1: Write the failing test**

```ts
// tests/face-theme.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/app/globals.css', 'utf8')
const nginx = readFileSync('deploy/loupe.nginx.conf', 'utf8')

describe('per-face look and hosts', () => {
  it.each(['home', 'qc', 'ship'])('%s re-tints the shared tokens', (face) => {
    const block = css.match(new RegExp(`:root\\[data-face="${face}"\\]\\s*{([^}]*)}`))?.[1] ?? ''
    for (const token of ['--bg', '--surface', '--ink', '--ink-soft', '--chip', '--line', '--face-accent', '--face-accent-2']) expect(block).toContain(`${token}:`)
  })
  it('Loupe keeps its palette and the accent tokens have Loupe defaults', () => {
    expect(css).not.toContain('[data-face="loupe"]')
    expect(css).toContain('--face-accent: var(--ink)'); expect(css).toContain('--color-face-accent: var(--face-accent)')
  })
  it('nginx serves all four hosts on 443 and on 80', () => {
    const names = [...nginx.matchAll(/server_name ([^;]+);/g)].map((m) => m[1].trim().split(/\s+/).sort())
    expect(names).toHaveLength(2)
    for (const list of names) expect(list).toEqual(['loupe.qimati-eng.site', 'qc.qimati-eng.site', 'qimati-eng.site', 'ship.qimati-eng.site'])
    expect(nginx).toContain('/etc/letsencrypt/live/loupe.qimati-eng.site/fullchain.pem')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/face-theme.test.ts`
Expected: FAIL — no `data-face` blocks, one server name.

- [ ] **Step 3: The palettes**

In `src/app/globals.css`, directly after the closing `}` of the `:root { … }` block, add:

```css
/*
 * Per-face palettes (D136). `data-face` on <html> is set by the root layout from the
 * header the proxy derived from the hostname. Loupe keeps the monochrome tokens above —
 * the photographs stay the only colour there. The other faces re-tint the SAME tokens
 * from the owner's three mood images, so every component, radius and layout is shared
 * and untouched. --face-accent / --face-accent-2 exist for Home's tiles and lights.
 */
:root {
  --face-accent: var(--ink);
  --face-accent-2: var(--chip);
}
/* Home: white, orange, deep green. */
:root[data-face="home"] {
  --bg: #f4efe6;
  --surface: #fffdf8;
  --ink: #1b3f31;
  --ink-soft: #3f5b4e;
  --chip: #efe7d8;
  --line: #e6dfd0;
  --face-accent: #e8752e;
  --face-accent-2: #1b3f31;
}
/* Order QC: soft pink, cream. */
:root[data-face="qc"] {
  --bg: #f7edf0;
  --surface: #fffaf8;
  --ink: #4a2233;
  --ink-soft: #6d4557;
  --chip: #f4e0e5;
  --line: #ecd9de;
  --face-accent: #d98a9c;
  --face-accent-2: #f3dcc8;
}
/* Fulfilment: teal, sand. */
:root[data-face="ship"] {
  --bg: #ebf2f1;
  --surface: #fbfaf5;
  --ink: #103c45;
  --ink-soft: #36595f;
  --chip: #dfe9e7;
  --line: #d6e2df;
  --face-accent: #2a9d8f;
  --face-accent-2: #e6dab9;
}
```

In the `@theme inline { … }` block, after `--color-line: var(--line);`, add:
```css
  --color-face-accent: var(--face-accent);
  --color-face-accent-2: var(--face-accent-2);
```

- [ ] **Step 4: nginx**

In `deploy/loupe.nginx.conf` change both `server_name loupe.qimati-eng.site;` lines to
```
    server_name qimati-eng.site qc.qimati-eng.site ship.qimati-eng.site loupe.qimati-eng.site;
```
and replace the header comment's TLS line with:
```
# TLS: Let's Encrypt via certbot (webroot /var/www/html); renewal is certbot's timer.
# One certificate lineage, `loupe.qimati-eng.site`, expanded to all four names (D136):
#   sudo certbot certonly --webroot -w /var/www/html --cert-name loupe.qimati-eng.site --expand \
#     -d loupe.qimati-eng.site -d qimati-eng.site -d qc.qimati-eng.site -d ship.qimati-eng.site
# so the ssl_certificate paths below never change.
```
Nothing else in the file changes (the certificate paths stay).

- [ ] **Step 5: Run the test, lint nothing (CSS and nginx have no linter here), and confirm the CSS still compiles**

Run: `npx vitest run tests/face-theme.test.ts && npm run typecheck`
Expected: PASS; typecheck clean. (The CSS is compiled by `next build` in Task 14; a typo in a custom-property block cannot break the build, it only fails to apply.)

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css deploy/loupe.nginx.conf tests/face-theme.test.ts
git commit -m "feat(platform): one palette per face on the shared tokens; nginx serves all four hosts"
```
