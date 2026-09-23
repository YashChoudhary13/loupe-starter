# Qimati Platform — Implementation Plan, part 1 of 10 (faces, proxy, origins, one sign-in)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One codebase wearing four faces chosen by hostname (`qimati-eng.site` Home, `qc.` Order QC, `ship.` Fulfilment, `loupe.` Loupe), one Google sign-in shared across them, and a Home dashboard with health lights, five numbers and a read-only AI whose only actions are three confirm-gated WhatsApp-bot calls.

**Architecture:** A pure face table (`src/lib/faces/faces.ts`) drives a Next 16 `proxy.ts` that sets `x-face` and redirects foreign screens to their owning host; the shell reads the header for the menu and the palette. Session cookies gain the `.qimati-eng.site` domain in production. Home is three server-side libraries — probes, numbers, and an AI tool loop over a `ReadOnlyShopify` wrapper — with every external call injected so it is unit-tested against fakes. The plan is split into ten files so each stays under 500 lines; do them in order.

**Tech Stack:** Next.js 16 App Router (`src/proxy.ts`), TypeScript strict, Supabase Postgres (service role, RLS deny-all), Shopify Admin GraphQL via `ShopifyClient`, OpenRouter chat completions with tool calling, n8n public REST API, vitest (`environment: 'node'`, `renderToString` for components).

**Spec:** `docs/superpowers/specs/2026-09-23-platform-faces-design.md` (approved in full; do not reopen its decisions).

## Plan files

1. `2026-09-23-platform-1-faces-auth.md` — Tasks 1–3: face table + proxy; own-origin checks; domain cookies and face-aware sign-in
2. `2026-09-23-platform-2-shell-look.md` — Tasks 4–5: per-face shell and Apps switcher; palettes, nginx names
3. `2026-09-23-platform-3-n8n.md` — Task 6: the n8n client
4. `2026-09-23-platform-4-probes.md` — Task 7: probes, state table, schema proof, the Shopify throttle reading
5. `2026-09-23-platform-5-reads-numbers.md` — Task 8: read-only Shopify, the numbers, the probe store, the cached server snapshot
6. `2026-09-23-platform-6-tools-actions.md` — Tasks 9–10: read tools; confirm-gated actions
7. `2026-09-23-platform-7-chat-turn.md` — Task 11: the chat turn (OpenRouter tool loop, budgets, rate limit)
8. `2026-09-23-platform-8-routes.md` — Task 12: the chat stream route and the confirm route
9. `2026-09-23-platform-9-home-screen.md` — Task 13: the Home screen
10. `2026-09-23-platform-10-docs-rollout.md` — Task 14: decisions, CLAUDE.md, full verification, progress entry, rollout

## Global Constraints

- Work only in `/Users/yash/Desktop/Qimati-worktrees/loupe-platform` on branch `claude/platform`. Commit locally with the exact message given. **Never push, never merge, never switch or delete branches** — a push to `main` deploys production within a minute.
- Never apply a migration, never run `scripts/apply-migration.ts` or `npm run db:push`, never run the dev server against production, never change Shopify scopes, DNS or the server, never send any message. Those are the owner's rollout steps (part 10, Task 14).
- No test or script may fulfil, edit or message a real order, or touch a real database or Shopify. Fake every external system at the client boundary (`fetchImpl`, a fake `supabaseServer`, a fake `ShopifyClient`). No `.env` exists in this worktree and none is needed; never look for credentials.
- **Never run the whole test suite** — some files write to the real Supabase project. Run only the focused files named in each task: `npx vitest run tests/<file>`.
- The AI reads only. It never gets a way to write to Shopify, the website, products, discounts, customers or orders. Its only actions are the three WhatsApp-bot actions, hidden until `BOT_REPORT_WEBHOOK_URL` / `BOT_STAFF_TEXT_WEBHOOK_URL` and `BOT_WEBHOOK_SECRET` exist. No customer name, phone or address reaches the model; every Shopify query the AI can trigger is a constant string in source.
- Secrets never reach the browser or the model. `x-face` is set by the proxy and never trusted from the client.
- Faces, hosts and screens are exactly: `home` `qimati-eng.site` [`/home`] · `loupe` `loupe.qimati-eng.site` [`/console`, `/upload`, `/identify`, `/restock`, `/tracking`, `/prompts`, `/models`, `/workflows`] · `qc` `qc.qimati-eng.site` [`/qc`, `/labels`] · `ship` `ship.qimati-eng.site` [`/dispatch`]. `/api/*`, `/login`, `/health` and static assets are allowed on every face. An unknown host is `loupe` in production. Cookie domain in production: `.qimati-eng.site`.
- Model default `anthropic/claude-haiku-4.5` via `HOME_CHAT_MODEL`; per turn at most 6 tool calls and 4 000 output tokens; history capped at 20 turns / 6 000 tokens (24 000 characters); 60 turns per user per hour. Confirm tokens: signed with `AUTH_SESSION_SECRET`, bound to the user, 5 minutes, single use.
- Probe timeouts 5 s; probe cache 30 s per process; numbers cache 60 s. `home_probe_state` records only the last change per probe; every change writes an `events` row `home.probe_changed`.
- Commit messages carry no `Co-Authored-By` or any other trailer. Every source file stays under 500 lines. Match the terse single-line style of `src/lib/dispatch/*.ts`. Known lint baseline: 5 errors in `scripts/tmp-promote-worn.ts`, `src/components/live/LiveActivity.tsx`, `tests/app-shell-render.test.ts` — do not fix those files; add no new lint errors (`npx eslint <changed files>`).
- `npm run typecheck` includes `tests/**`, so a changed component prop must be reflected in its existing render test.
- PostgreSQL 17 for local schema proofs is at `/opt/homebrew/opt/postgresql@17/bin` (temporary data directory, never a real database).

---

### Task 1: Face table and the proxy

**Files:**
- Create: `src/lib/faces/faces.ts`
- Create: `src/proxy.ts`
- Modify: `.env.local.example` (add `FACE_DEV`)
- Test: `tests/faces.test.ts`, `tests/proxy.test.ts`

**Interfaces:**
- Produces: `FACE_DOMAIN`, `FACES`, `Face`, `FACE_KEYS`, `isFace(value)`, `faceFromHeader(value)`, `faceOfHost(host)`, `faceForHost(host, { dev?, production })`, `screenAllowed(face, pathname)`, `owningFace(pathname)`, `faceHome(face)`, `faceOrigins()`, `faceReturnUrl(face, fallbackBase)`, `faceRoute({ host, pathname, dev?, production })` (all pure, no env, no Next import).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/faces.test.ts
import { describe, expect, it } from 'vitest'
import { FACES, faceForHost, faceFromHeader, faceHome, faceOfHost, faceOrigins, faceReturnUrl, faceRoute, owningFace, screenAllowed } from '@/lib/faces/faces'

const prod = { production: true }
describe('faces by host', () => {
  it.each([['qimati-eng.site', 'home'], ['loupe.qimati-eng.site', 'loupe'], ['qc.qimati-eng.site', 'qc'], ['ship.qimati-eng.site', 'ship'], ['QC.qimati-eng.site:443', 'qc']])('%s is %s', (host, face) => {
    expect(faceOfHost(host)).toBe(face); expect(faceForHost(host, prod)).toBe(face)
  })
  it('an unknown host is Loupe in production and unrestricted on a dev machine', () => {
    expect(faceForHost('203.0.113.9', prod)).toBe('loupe'); expect(faceForHost(null, prod)).toBe('loupe')
    expect(faceForHost('localhost:3000', { production: false })).toBeNull()
  })
  it('FACE_DEV picks a face on a dev machine but never overrides a real host', () => {
    expect(faceForHost('localhost:3000', { production: false, dev: 'home' })).toBe('home')
    expect(faceForHost('localhost:3000', { production: false, dev: 'nope' })).toBeNull()
    expect(faceForHost('qc.qimati-eng.site', { production: false, dev: 'home' })).toBe('qc')
    expect(faceForHost('203.0.113.9', { production: true, dev: 'ship' })).toBe('loupe')
  })
  it('reads the proxy header and nothing else', () => { expect(faceFromHeader('ship')).toBe('ship'); expect(faceFromHeader('evil')).toBeNull(); expect(faceFromHeader(null)).toBeNull(); expect(faceFromHeader('constructor')).toBeNull(); expect(faceFromHeader('__proto__')).toBeNull() })
})
describe('screens', () => {
  it("allows only the face's own screens, plus the api, sign-in, health and assets", () => {
    expect(screenAllowed('qc', '/qc')).toBe(true); expect(screenAllowed('qc', '/qc/123')).toBe(true); expect(screenAllowed('qc', '/qc/shortages')).toBe(true); expect(screenAllowed('qc', '/labels')).toBe(true)
    expect(screenAllowed('qc', '/console')).toBe(false); expect(screenAllowed('qc', '/qcx')).toBe(false); expect(screenAllowed('ship', '/qc')).toBe(false); expect(screenAllowed('home', '/dispatch')).toBe(false)
    for (const path of ['/api/qc/1', '/login', '/health', '/_next/static/x.js', '/favicon.ico']) expect(screenAllowed('home', path)).toBe(true)
    expect(screenAllowed(null, '/dispatch')).toBe(true)
  })
  it("knows each screen's owner, each face's first screen and every origin", () => {
    expect(owningFace('/dispatch')).toBe('ship'); expect(owningFace('/console/drafts/1')).toBe('loupe'); expect(owningFace('/nope')).toBeNull()
    expect(faceHome('home')).toBe('/home'); expect(faceHome('qc')).toBe('/qc'); expect(faceHome(null)).toBe('/console')
    expect(faceOrigins()).toEqual(['https://qimati-eng.site', 'https://loupe.qimati-eng.site', 'https://qc.qimati-eng.site', 'https://ship.qimati-eng.site'])
    expect(new Set(Object.values(FACES).map(face => face.host)).size).toBe(4)
  })
})
describe('routing one request', () => {
  it("sends / to the face's first screen, absolute on a real host and relative elsewhere", () => {
    expect(faceRoute({ host: 'qc.qimati-eng.site', pathname: '/', production: true })).toEqual({ face: 'qc', redirect: 'https://qc.qimati-eng.site/qc' })
    expect(faceRoute({ host: 'localhost:3000', pathname: '/', production: false })).toEqual({ face: null, redirect: '/console' })
    expect(faceRoute({ host: 'localhost:3000', pathname: '/', production: false, dev: 'home' })).toEqual({ face: 'home', redirect: '/home' })
    expect(faceRoute({ host: '127.0.0.1:3000', pathname: '/', production: true })).toEqual({ face: 'loupe', redirect: 'https://loupe.qimati-eng.site/console' })
  })
  it("sends another face's screen to that face, keeps its own, and leaves unknown paths to 404", () => {
    expect(faceRoute({ host: 'qc.qimati-eng.site', pathname: '/console/drafts/1', production: true })).toEqual({ face: 'qc', redirect: 'https://loupe.qimati-eng.site/console/drafts/1' })
    expect(faceRoute({ host: 'ship.qimati-eng.site', pathname: '/dispatch', production: true })).toEqual({ face: 'ship', redirect: null })
    expect(faceRoute({ host: 'qimati-eng.site', pathname: '/api/home/chat', production: true })).toEqual({ face: 'home', redirect: null })
    expect(faceRoute({ host: 'qimati-eng.site', pathname: '/nope', production: true })).toEqual({ face: 'home', redirect: null })
    expect(faceRoute({ host: '203.0.113.9', pathname: '/home', production: true })).toEqual({ face: 'loupe', redirect: 'https://qimati-eng.site/home' })
  })
  it('returns a finished sign-in to the recorded face host, else to the configured base', () => {
    expect(faceReturnUrl('qc', 'https://qimati-eng.site')).toBe('https://qc.qimati-eng.site/')
    expect(faceReturnUrl('evil.example', 'https://qimati-eng.site/')).toBe('https://qimati-eng.site/')
    expect(faceReturnUrl(undefined, 'http://localhost:3000')).toBe('http://localhost:3000/')
  })
})
```

```ts
// tests/proxy.test.ts
import { getRedirectUrl } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

afterEach(() => { delete process.env.FACE_DEV })
const at = (url: string, extra: Record<string, string> = {}) => new NextRequest(url, { headers: { host: new URL(url).host, ...extra } })

describe('proxy', () => {
  it('sends a wrong-host screen to its owner with the same path and query, 307', () => {
    const response = proxy(at('https://qc.qimati-eng.site/console?x=1'))
    expect(response.status).toBe(307)
    expect(getRedirectUrl(response)).toBe('https://loupe.qimati-eng.site/console?x=1')
  })
  it("sends / to the face's first screen", () => { expect(getRedirectUrl(proxy(at('https://ship.qimati-eng.site/')))).toBe('https://ship.qimati-eng.site/dispatch') })
  it("lets the api, sign-in, health and the face's own screens through with x-face set", () => {
    for (const path of ['/api/qc/1', '/login', '/health', '/qc/123']) {
      const response = proxy(at(`https://qc.qimati-eng.site${path}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('x-middleware-request-x-face')).toBe('qc')
    }
  })
  it('never trusts an x-face header sent by the client', () => {
    expect(proxy(at('https://qc.qimati-eng.site/qc', { 'x-face': 'home' })).headers.get('x-middleware-request-x-face')).toBe('qc')
  })
  it('on a dev machine without FACE_DEV every screen is allowed and no face is set', () => {
    const response = proxy(at('http://localhost:3000/dispatch'))
    expect(response.status).toBe(200); expect(response.headers.get('x-middleware-request-x-face')).toBeNull()
  })
  it('with FACE_DEV a dev machine wears one face', () => {
    process.env.FACE_DEV = 'home'
    expect(getRedirectUrl(proxy(at('http://localhost:3000/dispatch')))).toBe('https://ship.qimati-eng.site/dispatch')
    expect(getRedirectUrl(proxy(at('http://localhost:3000/')))).toBe('http://localhost:3000/home')
  })
  it('skips static assets', () => { expect(config.matcher[0]).toContain('_next/static') })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/faces.test.ts tests/proxy.test.ts`
Expected: FAIL — cannot resolve `@/lib/faces/faces` and `@/proxy`.

- [ ] **Step 3: Implement the face table**

```ts
// src/lib/faces/faces.ts
/** The four faces of one app, chosen by hostname (D136). Pure: no env, no Next import, so the proxy, the shell and tests share it. */
export const FACE_DOMAIN = 'qimati-eng.site'
export const FACES = {
  home: { host: 'qimati-eng.site', label: 'Qimati', screens: ['/home'] },
  loupe: { host: 'loupe.qimati-eng.site', label: 'Loupe', screens: ['/console', '/upload', '/identify', '/restock', '/tracking', '/prompts', '/models', '/workflows'] },
  qc: { host: 'qc.qimati-eng.site', label: 'Order QC', screens: ['/qc', '/labels'] },
  ship: { host: 'ship.qimati-eng.site', label: 'Fulfilment', screens: ['/dispatch'] },
} as const
export type Face = keyof typeof FACES
export const FACE_KEYS = Object.keys(FACES) as Face[]
/** Served by every face: the API, sign-in, diagnostics, Next's own assets and any file with an extension. */
const OPEN_PREFIXES = ['/api/', '/login', '/health', '/_next/']

export function isFace(value: unknown): value is Face { return typeof value === 'string' && Object.hasOwn(FACES, value) }
/** The `x-face` request header the proxy sets. Anything else (including a client-sent value the proxy dropped) is no face. */
export function faceFromHeader(value: string | null | undefined): Face | null { return isFace(value) ? value : null }
export function faceOfHost(host: string | null | undefined): Face | null {
  const name = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '')
  return FACE_KEYS.find(face => FACES[face].host === name) ?? null
}
/** A real face host wins; production always falls back to Loupe so a stray DNS record never shows a blank page — FACE_DEV is for local work only; a dev machine with neither is unrestricted (null). */
export function faceForHost(host: string | null | undefined, options: { dev?: string; production: boolean }): Face | null {
  const real = faceOfHost(host)
  if (real) return real
  if (options.production) return 'loupe'
  if (isFace(options.dev)) return options.dev
  return null
}
const under = (pathname: string, screen: string) => pathname === screen || pathname.startsWith(`${screen}/`)
export function screenAllowed(face: Face | null, pathname: string): boolean {
  if (face === null) return true
  if (OPEN_PREFIXES.some(prefix => pathname.startsWith(prefix)) || /\.[a-z0-9]+$/i.test(pathname)) return true
  return FACES[face].screens.some(screen => under(pathname, screen))
}
export function owningFace(pathname: string): Face | null { return FACE_KEYS.find(face => FACES[face].screens.some(screen => under(pathname, screen))) ?? null }
export function faceHome(face: Face | null): string { return face ? FACES[face].screens[0] : '/console' }
export function faceOrigins(): string[] { return FACE_KEYS.map(face => `https://${FACES[face].host}`) }
/** Where a finished sign-in returns to: the face host recorded when it started, else the configured base. Never a value the browser chose. */
export function faceReturnUrl(face: unknown, fallbackBase: string): string { return isFace(face) ? `https://${FACES[face].host}/` : `${fallbackBase.replace(/\/+$/, '')}/` }

export interface FaceRoute { face: Face | null; redirect: string | null }
/** The proxy's decision for one request. A redirect is absolute whenever the request arrived on a real face host or the app is in production, so it can never resolve against a bind address like 127.0.0.1 behind nginx. */
export function faceRoute(input: { host: string | null | undefined; pathname: string; dev?: string; production: boolean }): FaceRoute {
  const face = faceForHost(input.host, input)
  const real = faceOfHost(input.host)
  const origin = face && (real || input.production) ? `https://${FACES[face].host}` : ''
  if (input.pathname === '/') return { face, redirect: `${origin}${faceHome(face)}` }
  if (screenAllowed(face, input.pathname)) return { face, redirect: null }
  const owner = owningFace(input.pathname)
  return { face, redirect: owner ? `https://${FACES[owner].host}${input.pathname}` : null }
}
```

- [ ] **Step 4: Implement the proxy**

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from 'next/server'
import { faceRoute } from '@/lib/faces/faces'

/** Every request: pick the face from the host, tell the app with `x-face`, and send a screen that belongs to another face to that face's host (D136). */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  const { face, redirect } = faceRoute({ host: request.headers.get('host') ?? request.nextUrl.host, pathname, dev: process.env.FACE_DEV, production: process.env.NODE_ENV === 'production' })
  if (redirect) return NextResponse.redirect(new URL(`${redirect}${search}`, request.url), 307)
  const headers = new Headers(request.headers)
  if (face) headers.set('x-face', face)
  else headers.delete('x-face')
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
```

Append to `.env.local.example`, under the `AUTH_BASE_URL` entry:

```
# Dev only: wear one face on localhost (home | loupe | qc | ship). Unset = every screen allowed, as before.
# FACE_DEV=home
```

- [ ] **Step 5: Run the tests, then typecheck and lint**

Run: `npx vitest run tests/faces.test.ts tests/proxy.test.ts && npm run typecheck && npx eslint src/lib/faces/faces.ts src/proxy.ts tests/faces.test.ts tests/proxy.test.ts`
Expected: all PASS; typecheck clean; no lint errors. If `next/experimental/testing/server` cannot be imported under vitest, replace `getRedirectUrl(response)` with `response.headers.get('location')` in the test and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add src/lib/faces/faces.ts src/proxy.ts .env.local.example tests/faces.test.ts tests/proxy.test.ts
git commit -m "feat(platform): face table and proxy — host picks the face, foreign screens redirect to their owner"
```

---

### Task 2: Own-origin checks for four hosts, and the migration script's origin guard

**Files:**
- Create: `src/lib/faces/server.ts`
- Modify: `src/app/api/qc/[orderId]/route.ts:28`, `src/app/api/labels/print/route.ts:14`, `src/app/api/labels/prepare/route.ts:14`, `scripts/apply-migration.ts:18`
- Test: `tests/faces-origin.test.ts` (new); `tests/qc-route.test.ts`, `tests/label-print-route.test.ts`, `tests/prepare-codes-route.test.ts` (existing, must keep passing)

**Interfaces:**
- Consumes: `faceOrigins()` (Task 1), `serverEnv.authBaseUrl`.
- Produces: `isOwnOrigin(origin: string | null): boolean` — the base origin or any face origin.

Why: three browser-facing routes refuse any `Origin` other than `AUTH_BASE_URL`. After rollout `AUTH_BASE_URL` is `https://qimati-eng.site`, but QC scanning and label printing happen on `qc.qimati-eng.site` — without this change every scan would be answered 403. `scripts/apply-migration.ts` refuses unless `AUTH_BASE_URL` is still the Loupe host, and the spec applies migrations (step 5) after the env change (step 4).

- [ ] **Step 1: Write the failing test**

```ts
// tests/faces-origin.test.ts
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://qimati-eng.site/' } }))
import { isOwnOrigin } from '@/lib/faces/server'

describe('own origins', () => {
  it('accepts the base origin and every face host, nothing else', () => {
    for (const origin of ['https://qimati-eng.site', 'https://qc.qimati-eng.site', 'https://ship.qimati-eng.site', 'https://loupe.qimati-eng.site']) expect(isOwnOrigin(origin)).toBe(true)
    for (const origin of ['https://evil.example', 'http://qc.qimati-eng.site', 'https://qc.qimati-eng.site.evil', 'https://qimati-eng.site.evil', null, '']) expect(isOwnOrigin(origin)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/faces-origin.test.ts`
Expected: FAIL — cannot resolve `@/lib/faces/server`.

- [ ] **Step 3: Implement the helper and use it in the three routes**

```ts
// src/lib/faces/server.ts
import { serverEnv } from '@/lib/env'
import { faceOrigins } from './faces'

/** The console's own browser origins: AUTH_BASE_URL plus every face host. A form or fetch from anywhere else is refused (D136). No `server-only` import here on purpose: `@/lib/env` already carries it, and the route tests mock that module. */
export function isOwnOrigin(origin: string | null): boolean {
  if (!origin) return false
  return origin === new URL(serverEnv.authBaseUrl).origin || faceOrigins().includes(origin)
}
```

In `src/app/api/qc/[orderId]/route.ts` replace the origin line with
```ts
    if (!isOwnOrigin(request.headers.get('origin'))) return Response.json({ error: 'Open QC in Loupe to scan products.' }, { status: 403, headers })
```
add `import { isOwnOrigin } from '@/lib/faces/server'` and delete the now-unused `import { serverEnv } from '@/lib/env'`.

In `src/app/api/labels/print/route.ts` replace line 14 with
```ts
    if (!isOwnOrigin(request.headers.get('origin'))) return new Response('Open Labels in Loupe before printing.', { status: 403 })
```
and in `src/app/api/labels/prepare/route.ts` replace line 14 with
```ts
    if (!isOwnOrigin(request.headers.get('origin'))) return reply({ error: 'Open Labels in Loupe first.' }, 403)
```
In both, add the `isOwnOrigin` import and remove the unused `serverEnv` import.

In `scripts/apply-migration.ts` replace line 18 with:
```ts
  const PRODUCTION_ORIGINS = ['https://loupe.qimati-eng.site', 'https://qimati-eng.site']
  if (!PRODUCTION_ORIGINS.includes(process.env.AUTH_BASE_URL ?? '')) throw new Error('This rollout targets the configured production origin (Loupe, or the Qimati home after D136).')
```

- [ ] **Step 4: Run the new and the existing route tests, typecheck, lint**

Run: `npx vitest run tests/faces-origin.test.ts tests/qc-route.test.ts tests/label-print-route.test.ts tests/prepare-codes-route.test.ts && npm run typecheck && npx eslint src/lib/faces/server.ts "src/app/api/qc/[orderId]/route.ts" src/app/api/labels/print/route.ts src/app/api/labels/prepare/route.ts scripts/apply-migration.ts`
Expected: every file PASS (the existing tests mock `@/lib/env` with `https://loupe.example`, which stays accepted and `https://other.example` stays refused); typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/faces/server.ts "src/app/api/qc/[orderId]/route.ts" src/app/api/labels/print/route.ts src/app/api/labels/prepare/route.ts scripts/apply-migration.ts tests/faces-origin.test.ts
git commit -m "fix(platform): QC and Labels accept requests from every face host; apply-migration accepts the Qimati home origin"
```

---

### Task 3: One sign-in for four hosts — domain cookies, face-aware return, sign-out everywhere

**Files:**
- Modify: `src/lib/auth/cookies.ts`, `src/app/api/auth/google/start/route.ts`, `src/app/api/auth/google/callback/route.ts`, `src/app/api/auth/signout/route.ts`, `src/app/login/page.tsx:32`
- Test: `tests/auth-cookies.test.ts`, `tests/auth-routes.test.ts`

**Interfaces:**
- Consumes: `FACE_DOMAIN`, `faceOfHost`, `faceReturnUrl` (Task 1); `encodeSignedValue`/`decodeSignedValue` (`src/lib/auth/session.ts`).
- Produces: `cookieDomain(): string | undefined`, `clearHostOnlyCookieHeader(name): string` (cookies.ts); the handshake cookie payload gains an optional `face`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/auth-cookies.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ authBaseUrl: 'https://qimati-eng.site' }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ serverEnv: { get authBaseUrl() { return env.authBaseUrl } } }))
import { clearedCookieOptions, clearHostOnlyCookieHeader, cookieDomain, sessionCookieOptions, shortLivedCookieOptions } from '@/lib/auth/cookies'

describe('cookie domain', () => {
  beforeEach(() => { env.authBaseUrl = 'https://qimati-eng.site' })
  it('is .qimati-eng.site in production, on every cookie', () => {
    expect(cookieDomain()).toBe('.qimati-eng.site')
    expect(sessionCookieOptions()).toMatchObject({ domain: '.qimati-eng.site', secure: true, httpOnly: true, sameSite: 'lax', path: '/' })
    expect(shortLivedCookieOptions(600)).toMatchObject({ domain: '.qimati-eng.site', maxAge: 600 })
    expect(clearedCookieOptions()).toMatchObject({ domain: '.qimati-eng.site', maxAge: 0 })
  })
  it('is absent on http (dev) and on a host outside the platform domain', () => {
    env.authBaseUrl = 'http://localhost:3000'; expect(cookieDomain()).toBeUndefined(); expect('domain' in sessionCookieOptions()).toBe(false)
    env.authBaseUrl = 'https://loupe.example'; expect(cookieDomain()).toBeUndefined()
  })
  it('can still clear the pre-platform host-only cookie', () => {
    expect(clearHostOnlyCookieHeader('loupe_session')).toBe('loupe_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
    env.authBaseUrl = 'http://localhost:3000'; expect(clearHostOnlyCookieHeader('loupe_session')).toBe('loupe_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
  })
})
```

```ts
// tests/auth-routes.test.ts
import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
const SECRET = 'a'.repeat(64)
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/env', () => ({ serverEnv: { authSessionSecret: 'a'.repeat(64), authBaseUrl: 'https://qimati-eng.site' } }))
vi.mock('@/lib/auth/authorize', () => ({
  currentOperator: async () => null,
  googleOAuthConfig: () => ({ clientId: 'x.apps.googleusercontent.com', clientSecret: 's', redirectUri: 'https://qimati-eng.site/api/auth/google/callback' }),
}))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }))
import { GET as start } from '@/app/api/auth/google/start/route'
import { POST as signout } from '@/app/api/auth/signout/route'
import { decodeSignedValue, OAUTH_COOKIE } from '@/lib/auth/session'

const startOn = (host: string) => start(new NextRequest(`https://${host}/api/auth/google/start`, { headers: { host } }))
describe('sign-in start', () => {
  it('records the face whose host started the sign-in, in a domain cookie', async () => {
    const response = await startOn('qc.qimati-eng.site')
    expect(response.headers.get('location')).toContain('accounts.google.com')
    const cookie = response.cookies.get(OAUTH_COOKIE)
    expect(cookie?.domain).toBe('.qimati-eng.site')
    expect(decodeSignedValue<{ face?: string }>(SECRET, cookie?.value)?.face).toBe('qc')
  })
  it('records no face for a host outside the platform', async () => {
    const cookie = (await startOn('evil.example')).cookies.get(OAUTH_COOKIE)
    expect(decodeSignedValue<{ face?: string }>(SECRET, cookie?.value)?.face).toBeUndefined()
  })
})
describe('sign-out', () => {
  it('clears the domain cookie and the old host-only cookie, then returns to the home sign-in', async () => {
    const response = await signout()
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('https://qimati-eng.site/login')
    const cookies = response.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith('loupe_session=') && /domain=\.qimati-eng\.site/i.test(c) && /max-age=0/i.test(c))).toBe(true)
    expect(cookies.some(c => c.startsWith('loupe_session=') && !/domain=/i.test(c) && /max-age=0/i.test(c))).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/auth-cookies.test.ts tests/auth-routes.test.ts`
Expected: FAIL — `cookieDomain` / `clearHostOnlyCookieHeader` are not exported; `start` ignores its request; sign-out sets no host-only clear.

- [ ] **Step 3: Implement the cookies**

Replace the body of `src/lib/auth/cookies.ts` after the `secureCookies()` function with:

```ts
/** One sign-in for four hosts (D136): in production the cookies belong to `.qimati-eng.site`. Dev (http, localhost) and any base outside that domain keep host-only cookies. */
export function cookieDomain(): string | undefined {
  if (!secureCookies()) return undefined
  const host = new URL(serverEnv.authBaseUrl).hostname
  return host === FACE_DOMAIN || host.endsWith(`.${FACE_DOMAIN}`) ? `.${FACE_DOMAIN}` : undefined
}

function base() {
  const domain = cookieDomain()
  return { httpOnly: true, secure: secureCookies(), sameSite: 'lax' as const, path: '/', ...(domain ? { domain } : {}) }
}

export function sessionCookieOptions() { return { ...base(), maxAge: SESSION_TTL_SECONDS } }

/** The handshake and denial cookies exist for one redirect and then go away. */
export function shortLivedCookieOptions(maxAgeSeconds: number) { return { ...base(), maxAge: maxAgeSeconds } }

export function clearedCookieOptions() { return { ...base(), maxAge: 0 } }

/** A raw `Set-Cookie` that clears the pre-platform host-only cookie of the same name — a domain cookie cannot reach it, and `ResponseCookies` keeps one entry per name. */
export function clearHostOnlyCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookies() ? '; Secure' : ''}`
}
```
and add `import { FACE_DOMAIN } from '@/lib/faces/faces'` at the top. Keep the existing doc comment about `sameSite: 'lax'`.

- [ ] **Step 4: Record the face at start, return to it at the callback, clear both cookies at sign-out**

`src/app/api/auth/google/start/route.ts`: change the signature to `export async function GET(request: NextRequest): Promise<NextResponse>`, import `type NextRequest` from `next/server` and `faceOfHost` from `@/lib/faces/faces`, and build the handshake as
```ts
  const face = faceOfHost(request.headers.get('host'))
  response.cookies.set(
    OAUTH_COOKIE,
    encodeSignedValue(serverEnv.authSessionSecret, { state, codeVerifier, ...(face ? { face } : {}) }),
    shortLivedCookieOptions(HANDSHAKE_TTL_SECONDS),
  )
```
Update the doc comment: "The face whose host started the sign-in travels in the same signed cookie, so the callback (always on the Home host) can send the operator back where they were."

`src/app/api/auth/google/callback/route.ts`: `interface Handshake { state: string; codeVerifier: string; face?: string }`; import `faceReturnUrl` from `@/lib/faces/faces`; replace the success redirect line with
```ts
  const response = NextResponse.redirect(faceReturnUrl(handshake.face, serverEnv.authBaseUrl))
```
(`/` on that host is sent by the proxy to the face's first screen.)

`src/app/api/auth/signout/route.ts`: import `clearHostOnlyCookieHeader` from `@/lib/auth/cookies`; after the three `response.cookies.set(...)` lines add
```ts
  // Operators signed in before D136 still hold a host-only cookie on loupe.qimati-eng.site; the domain clear above cannot reach it.
  response.headers.append('set-cookie', clearHostOnlyCookieHeader(SESSION_COOKIE))
```
(this must stay after the last `response.cookies.set`, which rewrites the whole header).

`src/app/login/page.tsx` line 32: `if (await currentOperator()) redirect('/')` — the proxy sends `/` to the face's first screen.

- [ ] **Step 5: Run the tests, typecheck, lint**

Run: `npx vitest run tests/auth-cookies.test.ts tests/auth-routes.test.ts tests/auth-session.test.ts && npm run typecheck && npx eslint src/lib/auth/cookies.ts src/app/api/auth/google/start/route.ts src/app/api/auth/google/callback/route.ts src/app/api/auth/signout/route.ts src/app/login/page.tsx tests/auth-cookies.test.ts tests/auth-routes.test.ts`
Expected: all PASS; typecheck and lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/cookies.ts src/app/api/auth/google/start/route.ts src/app/api/auth/google/callback/route.ts src/app/api/auth/signout/route.ts src/app/login/page.tsx tests/auth-cookies.test.ts tests/auth-routes.test.ts
git commit -m "feat(platform): one sign-in for four hosts — .qimati-eng.site cookies, return to the face that started it, sign out everywhere"
```
