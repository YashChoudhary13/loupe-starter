# Qimati Platform — Implementation Plan, part 7 of 8 (chat and action routes, the Home screen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here. Tasks 12–13 consume parts 2–6.

---

### Task 12: `POST /api/home/chat` (NDJSON stream) and `POST /api/home/action` (confirm)

**Files:**
- Create: `src/app/api/home/chat/route.ts`, `src/app/api/home/action/route.ts`
- Test: `tests/home-routes.test.ts`

**Interfaces:**
- Consumes: `requireOperatorForAction`, `actorFor`, `NotAuthorisedError`, `Operator`; `isOwnOrigin` (Task 2); `availableActions`, `botConfig`, `consumeNonce`, `readConfirmToken` (Task 10); `DEFAULT_MODEL`, `rateLimiter`, `runChatTurn`, `systemPrompt`, `ChatEvent`, `ChatMessage` (Task 11); `homeSnapshot`, `homeToolContext` (Tasks 8–10); `READ_TOOLS` (Task 9); `postWebhook` (Task 6); `supabaseServer`.
- Produces: the two routes. Chat request `{ message: string; messages?: ChatMessage[] }` → `application/x-ndjson`, one `ChatEvent` per line, ending with `done` or `error`. Action request `{ token: string }` → `{ ok: boolean; text: string }` (200 / 502) or `{ ok: false; error }` (400 / 401 / 403 / 409 / 413 / 415).

- [ ] **Step 1: Write the failing test**

```ts
// tests/home-routes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ operator: vi.fn(), turn: vi.fn(), events: [] as unknown[], config: { report: null as string | null, staffText: null as string | null, secret: null as string | null }, posts: [] as unknown[] }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorForAction: mocks.operator, actorFor: (operator: { email: string }) => operator.email, NotAuthorisedError: class extends Error {} }))
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://qimati-eng.site', authSessionSecret: 'd'.repeat(64), openRouterApiKey: 'or-key' } }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: () => ({ insert: async (row: unknown) => { mocks.events.push(row); return { error: null } } }) }) }))
vi.mock('@/lib/home/server', () => ({ homeSnapshot: async () => ({ lights: [], numbers: { ordersToday: 1, paidUnfulfilled: 2, awaitingQc: 3, awaitingQcCapped: false, awaitingTracking: 4, openShortages: 5, problems: [], computedAt: 'x' }, actionsConnected: false }), homeToolContext: () => ({}) }))
vi.mock('@/lib/home/chat', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/home/chat')>()), runChatTurn: mocks.turn }))
vi.mock('@/lib/home/actions', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/home/actions')>()), botConfig: () => mocks.config }))
vi.mock('@/lib/home/n8n', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/home/n8n')>()), postWebhook: async (url: string, secret: string, body: unknown) => { mocks.posts.push({ url, secret, body }); return { status: 200, text: '' } } }))
import { NotAuthorisedError } from '@/lib/auth/authorize'
import { issueConfirmToken, resetNonces } from '@/lib/home/actions'
import { POST as chat } from '@/app/api/home/chat/route'
import { POST as confirm } from '@/app/api/home/action/route'

const SECRET = 'd'.repeat(64)
const request = (path: string, body: unknown, origin = 'https://qimati-eng.site') => new Request(`https://qimati-eng.site${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const lines = async (response: Response) => (await response.text()).trim().split('\n').map(line => JSON.parse(line))
beforeEach(() => {
  vi.clearAllMocks(); resetNonces(); mocks.events.length = 0; mocks.posts.length = 0; mocks.config = { report: null, staffText: null, secret: null }
  mocks.operator.mockResolvedValue({ id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'admin' })
  mocks.turn.mockImplementation(async (input: { emit: (event: unknown) => void }) => { input.emit({ type: 'text', text: 'All green.' }); return { model: 'm', promptTokens: 10, completionTokens: 5, cost: 0.001, toolCalls: 0 } })
})

describe('POST /api/home/chat', () => {
  it('needs a signed-in operator, our own origin, JSON and a message', async () => {
    mocks.operator.mockRejectedValueOnce(new NotAuthorisedError()); expect((await chat(request('/api/home/chat', { message: 'hi' }))).status).toBe(401)
    expect((await chat(request('/api/home/chat', { message: 'hi' }, 'https://evil.example'))).status).toBe(403)
    expect((await chat(request('/api/home/chat', { message: '   ' }))).status).toBe(400)
    expect((await chat(request('/api/home/chat', 'not json'))).status).toBe(400)
    expect(mocks.turn).not.toHaveBeenCalled()
  })
  it('streams the turn as NDJSON, ends with done, and records the cost line', async () => {
    const response = await chat(request('/api/home/chat', { message: 'How are we?', messages: [{ role: 'user', content: 'earlier' }, { role: 'system', content: 'ignored' }] }))
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/x-ndjson'); expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(await lines(response)).toEqual([{ type: 'text', text: 'All green.' }, { type: 'done', usage: { model: 'm', promptTokens: 10, completionTokens: 5, cost: 0.001, toolCalls: 0 } }])
    expect(mocks.turn.mock.calls[0][0]).toMatchObject({ uid: 'u1', message: 'How are we?', history: [{ role: 'user', content: 'earlier' }], apiKey: 'or-key', model: 'anthropic/claude-haiku-4.5', actions: [] })
    expect(mocks.turn.mock.calls[0][0].system).toContain('never write')
    expect(mocks.events[0]).toMatchObject({ event: 'home.chat_turn', actor: 'owner@example.test', detail: { toolCalls: 0, cost: 0.001 } })
  })
  it('turns a failed turn into an error event, never a crash', async () => {
    mocks.turn.mockRejectedValueOnce(new Error('Insufficient credits'))
    expect(await lines(await chat(request('/api/home/chat', { message: 'hi' })))).toEqual([{ type: 'error', text: 'Insufficient credits' }])
  })
  it('stops one user at sixty turns an hour', async () => {
    let status = 200
    for (let n = 0; n < 61 && status !== 429; n++) status = (await chat(request('/api/home/chat', { message: 'again' }))).status
    expect(status).toBe(429)
  })
})
describe('POST /api/home/action', () => {
  const token = () => issueConfirmToken(SECRET, { uid: 'u1', action: 'send_staff_text', params: { text: 'Pack faster' } })
  it('refuses a bad, foreign or expired token and an action that is not connected', async () => {
    expect((await confirm(request('/api/home/action', { token: 'nope' }))).status).toBe(400)
    expect((await confirm(request('/api/home/action', { token: issueConfirmToken(SECRET, { uid: 'u2', action: 'send_staff_text', params: { text: 'x' } }) }))).status).toBe(400)
    expect((await confirm(request('/api/home/action', { token: issueConfirmToken(SECRET, { uid: 'u1', action: 'send_staff_text', params: { text: 'x' } }, 1) }))).status).toBe(400)
    const response = await confirm(request('/api/home/action', { token: token() }))
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'That action is not connected yet.' })
    expect(mocks.posts).toHaveLength(0); expect(mocks.events).toHaveLength(0)
  })
  it('runs a connected action once, posts to the bot with the secret, logs it, and refuses the same card again', async () => {
    mocks.config = { report: null, staffText: 'https://n8n.example/webhook/staff', secret: 's3cret' }
    const card = token()
    const first = await confirm(request('/api/home/action', { token: card }))
    expect(first.status).toBe(200); expect(await first.json()).toEqual({ ok: true, text: 'Sent to the WhatsApp bot.' })
    expect(mocks.posts).toEqual([{ url: 'https://n8n.example/webhook/staff', secret: 's3cret', body: { action: 'staff_text', text: 'Pack faster', requested_by: 'owner@example.test' } }])
    expect(mocks.events[0]).toMatchObject({ event: 'home.action', actor: 'owner@example.test', detail: { action: 'send_staff_text', ok: true, params: { text: 'Pack faster' } } })
    const again = await confirm(request('/api/home/action', { token: card }))
    expect(again.status).toBe(409); expect(mocks.posts).toHaveLength(1)
  })
  it('needs a signed-in operator and our own origin', async () => {
    mocks.operator.mockRejectedValueOnce(new NotAuthorisedError()); expect((await confirm(request('/api/home/action', { token: token() }))).status).toBe(401)
    expect((await confirm(request('/api/home/action', { token: token() }, 'https://evil.example'))).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/home-routes.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Implement the chat route**

```ts
// src/app/api/home/chat/route.ts
import { actorFor, NotAuthorisedError, requireOperatorForAction, type Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { isOwnOrigin } from '@/lib/faces/server'
import { availableActions, botConfig } from '@/lib/home/actions'
import { DEFAULT_MODEL, rateLimiter, runChatTurn, systemPrompt, type ChatEvent, type ChatMessage } from '@/lib/home/chat'
import { homeSnapshot, homeToolContext } from '@/lib/home/server'
import { READ_TOOLS } from '@/lib/home/tools'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const limiter = rateLimiter()
const fail = (status: number, error: string) => Response.json({ error }, { status, headers })
const isMessage = (value: unknown): value is ChatMessage => !!value && typeof value === 'object' && ['user', 'assistant'].includes(String((value as ChatMessage).role)) && typeof (value as ChatMessage).content === 'string'

/** One question in; a stream of NDJSON events out — status lines while tools run, confirm cards for proposed actions, the answer, then `done` (D137). */
export async function POST(request: Request) {
  let operator: Operator
  try { operator = await requireOperatorForAction() } catch (error) { return fail(error instanceof NotAuthorisedError ? 401 : 500, 'Sign in again to chat.') }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to chat.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await request.text()
  if (text.length > 65_536) return fail(413, 'That conversation is too long. Start a new one.')
  let body: { messages?: unknown; message?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return fail(400, 'Say something first.')
  const history = (Array.isArray(body.messages) ? body.messages : []).filter(isMessage)
  if (!limiter.allow(operator.id)) return fail(429, 'Sixty questions an hour is the limit here. Try again later.')
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      try {
        const snapshot = await homeSnapshot(), actions = availableActions(botConfig())
        const usage = await runChatTurn({ apiKey: serverEnv.openRouterApiKey, model: process.env.HOME_CHAT_MODEL?.trim() || DEFAULT_MODEL, system: systemPrompt({ now: new Date(), lights: snapshot.lights, numbers: snapshot.numbers, actions }), history, message, tools: READ_TOOLS, actions, ctx: homeToolContext(), uid: operator.id, secret: serverEnv.authSessionSecret, emit })
        const { error } = await supabaseServer().from('events').insert({ entity_type: 'home_chat', event: 'home.chat_turn', detail: usage, actor: actorFor(operator) })
        if (error) console.warn('home.chat_turn not recorded:', error.message)
        emit({ type: 'done', usage })
      } catch (error) { emit({ type: 'error', text: error instanceof Error ? error.message : 'The assistant failed.' }) }
      finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } })
}
```

- [ ] **Step 4: Implement the action route**

```ts
// src/app/api/home/action/route.ts
import { actorFor, NotAuthorisedError, requireOperatorForAction, type Operator } from '@/lib/auth/authorize'
import { serverEnv } from '@/lib/env'
import { isOwnOrigin } from '@/lib/faces/server'
import { availableActions, botConfig, consumeNonce, readConfirmToken } from '@/lib/home/actions'
import { postWebhook } from '@/lib/home/n8n'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const fail = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers })

/** Confirm one card: the token must be valid, this user's, unexpired and unspent, and the action still connected. Every run, success or not, is logged as `home.action` (D137). */
export async function POST(request: Request) {
  let operator: Operator
  try { operator = await requireOperatorForAction() } catch (error) { return fail(error instanceof NotAuthorisedError ? 401 : 500, 'Sign in again.') }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to confirm.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await request.text()
  if (text.length > 8_192) return fail(413, 'Request too large.')
  let body: { token?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  const verdict = readConfirmToken(serverEnv.authSessionSecret, body.token, operator.id)
  if (!verdict.ok) return fail(400, verdict.error)
  const config = botConfig(), action = availableActions(config).find(item => item.name === verdict.payload.action)
  if (!action) return fail(409, 'That action is not connected yet.')
  if (!consumeNonce(verdict.payload.nonce, verdict.payload.exp)) return fail(409, 'That card was already confirmed.')
  let ok = true, result: string
  try { result = await action.run(verdict.payload.params, { post: postWebhook, config, actor: actorFor(operator) }) } catch (error) { ok = false; result = error instanceof Error ? error.message : 'The action failed.' }
  const { error } = await supabaseServer().from('events').insert({ entity_type: 'home_action', event: 'home.action', detail: { action: action.name, params: verdict.payload.params, ok, result }, actor: actorFor(operator) })
  if (error) console.warn('home.action not recorded:', error.message)
  return Response.json({ ok, text: result }, { status: ok ? 200 : 502, headers })
}
```

- [ ] **Step 5: Run the test, typecheck, lint**

Run: `npx vitest run tests/home-routes.test.ts && npm run typecheck && npx eslint src/app/api/home/chat/route.ts src/app/api/home/action/route.ts tests/home-routes.test.ts`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/home/chat/route.ts src/app/api/home/action/route.ts tests/home-routes.test.ts
git commit -m "feat(home): chat route streams NDJSON events; action route executes one confirmed card once and logs it"
```

---

### Task 13: The Home screen — lights, tiles, chat panel, confirm card

**Files:**
- Create: `src/components/home/HealthLight.tsx`, `src/components/home/NumberTile.tsx`, `src/components/home/ChatPanel.tsx`, `src/components/home/HomeScreen.tsx`, `src/app/(shell)/home/page.tsx`
- Test: `tests/home-screen-render.test.ts`

**Interfaces:**
- Consumes: `ProbeLight` (Task 7), `HomeSnapshot` (Tasks 8/10), `ChatEvent`, `ChatMessage`, `ConfirmCard` type (Task 11), the two routes (Task 12).
- Produces: `HealthLight({ light })`, `NumberTile({ label, value, capped?, href? })`, `ChatPanel({ actionsConnected })`, `ConfirmCard({ card, outcome?, onConfirm })`, `HomeScreen(snapshot)`, the `/home` page.

- [ ] **Step 1: Write the failing test**

```ts
// tests/home-screen-render.test.ts
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPanel, ConfirmCard } from '@/components/home/ChatPanel'
import { HomeScreen } from '@/components/home/HomeScreen'
import type { ProbeLight } from '@/lib/home/probes'

const light = (key: string, status: ProbeLight['status'], detail = 'HTTP 200 in 120 ms'): ProbeLight => ({ key, label: key, kind: 'http', status, detail, ms: 120, since: '2026-09-22T21:42:00Z', checkedAt: '2026-09-23T04:30:00Z' })
const numbers = { ordersToday: 4, paidUnfulfilled: 12, awaitingQc: 2, awaitingQcCapped: true, awaitingTracking: null, openShortages: 0, problems: ['awaiting tracking: db down'], computedAt: '2026-09-23T04:30:00Z' }
const render = (element: ReactElement) => renderToString(element).replace(/<!-- -->/g, '')

describe('Home screen', () => {
  it('shows every light with its since time, the five numbers, and the failed check', () => {
    const html = render(createElement(HomeScreen, { lights: [light('Loupe', 'green'), light('Shopify', 'red', '401'), light('Bot · Main', 'amber', 'run 8 error')], numbers, actionsConnected: false }))
    expect(html).toContain('Something is down.')
    expect(html).toContain('ok · 120 ms'); expect(html).toMatch(/red since 23 Sept?.*3:12.* · 401/); expect(html).toContain('amber since')
    expect(html).toContain('>4<'); expect(html).toContain('>12<'); expect(html).toContain('>2+<'); expect(html).toContain('>—<'); expect(html).toContain('>0<')
    expect(html).toContain('awaiting tracking: db down'); expect(html).toContain('href="/qc"'); expect(html).toContain('href="/dispatch"')
    expect(html).toContain('Bot actions are not connected yet.')
  })
  it('the chat panel starts empty with the read-only promise and an input', () => {
    const html = render(createElement(ChatPanel, { actionsConnected: true }))
    expect(html).toContain('never changes anything in Shopify'); expect(html).not.toContain('not connected yet'); expect(html).toContain('aria-label="Ask the assistant"')
  })
  it('a confirm card names the action, shows the summary, and sends nothing until confirmed', () => {
    const card = { action: 'send_staff_text', label: 'Send a message to staff', summary: 'Pack faster', params: { text: 'Pack faster' }, token: 't' }
    const html = render(createElement(ConfirmCard, { card, onConfirm: () => {} }))
    expect(html).toContain('Send a message to staff'); expect(html).toContain('Pack faster'); expect(html).toContain('>Confirm<'); expect(html).toContain('Nothing is sent until you confirm.')
    expect(render(createElement(ConfirmCard, { card, outcome: { ok: false, text: 'That action is not connected yet.' }, onConfirm: () => {} }))).toContain('That action is not connected yet.')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/home-screen-render.test.ts`
Expected: FAIL — the components do not exist.

- [ ] **Step 3: The lights and the tiles**

```tsx
// src/components/home/HealthLight.tsx
import type { ProbeLight } from '@/lib/home/probes'

const TONE = { green: 'bg-green', amber: 'bg-amber', red: 'bg-[#b3261e]' } as const
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** One health light: a dot, the label, and either "ok · 312 ms" or "red since 23 Sept, 03:12 am · HTTP 502". */
export function HealthLight({ light }: { light: ProbeLight }) {
  return (
    <li className="flex items-center gap-3 rounded-panel bg-surface px-4 py-3">
      <span aria-hidden className={`size-3 shrink-0 rounded-full ${TONE[light.status]}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{light.label}</div>
        <div className="truncate text-[11.5px] text-muted-foreground">{light.status === 'green' ? `ok · ${light.ms} ms` : `${light.status} since ${when(light.since)} · ${light.detail}`}</div>
      </div>
      <span className="sr-only">{light.status}</span>
    </li>
  )
}
```

```tsx
// src/components/home/NumberTile.tsx
/** One headline number. `null` means the check failed; `capped` means "at least this many". A plain anchor, because the target may live on another face (the proxy redirects). */
export function NumberTile({ label, value, capped = false, href }: { label: string; value: number | null; capped?: boolean; href?: string }) {
  const body = (
    <>
      <div className="text-[26px] font-medium tracking-[-0.025em] tabular-nums">{value === null ? '—' : `${value}${capped ? '+' : ''}`}</div>
      <div className="mt-1 text-[11.5px] text-muted-foreground">{label}</div>
    </>
  )
  const className = 'block rounded-panel bg-surface px-4 py-3 focus-visible:outline-2'
  return href ? <a href={href} className={`${className} hover:bg-chip`}>{body}</a> : <div className={className}>{body}</div>
}
```

- [ ] **Step 4: The chat panel and the confirm card**

```tsx
// src/components/home/ChatPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, ConfirmCard as Card } from '@/lib/home/chat'

type Entry = ChatMessage | { role: 'status'; content: string } | { role: 'card'; content: string; card: Card; outcome?: { ok: boolean; text: string } }
const pill = 'rounded-pill px-4 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40'
const isTurn = (entry: Entry): entry is ChatMessage => entry.role === 'user' || entry.role === 'assistant'

/** The conversation lives in this tab's React state and nowhere else (D137). */
export function ChatPanel({ actionsConnected }: { actionsConnected: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [entries])
  const append = (entry: Entry) => setEntries(current => [...current, entry])

  function handle(event: ChatEvent) {
    if (event.type === 'status') append({ role: 'status', content: event.text })
    else if (event.type === 'text' || event.type === 'error') append({ role: 'assistant', content: event.text })
    else if (event.type === 'confirm') append({ role: 'card', content: event.card.summary, card: event.card })
  }
  async function send() {
    const message = draft.trim()
    if (!message || busy) return
    const history = entries.filter(isTurn)
    setDraft(''); setBusy(true); append({ role: 'user', content: message })
    try {
      const response = await fetch('/api/home/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, messages: history }) })
      if (!response.ok || !response.body) { append({ role: 'assistant', content: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'The assistant did not answer.' }); return }
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const parts = buffer.split('\n'); buffer = parts.pop() ?? ''
        for (const part of parts) if (part.trim()) handle(JSON.parse(part) as ChatEvent)
        if (done) break
      }
    } catch { append({ role: 'assistant', content: 'The connection dropped. Ask again.' }) }
    finally { setBusy(false); setEntries(current => current.filter(entry => entry.role !== 'status')) }
  }
  async function confirmCard(index: number) {
    const entry = entries[index]
    if (!entry || entry.role !== 'card' || entry.outcome) return
    let outcome: { ok: boolean; text: string }
    try {
      const response = await fetch('/api/home/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: entry.card.token }) })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
      outcome = { ok: body.ok === true, text: body.text ?? body.error ?? 'No answer.' }
    } catch { outcome = { ok: false, text: 'The connection dropped.' } }
    setEntries(current => current.map((item, n) => (n === index && item.role === 'card' ? { ...item, outcome } : item)))
  }

  return (
    <div className="flex h-[min(70vh,640px)] flex-col rounded-card bg-surface p-4">
      <div className="loupe-scroll min-h-0 flex-1 overflow-auto">
        {entries.length === 0 && <p className="text-[13px] text-ink-soft">Ask about orders, stock, QC, dispatch or the bot. The assistant reads live numbers and never changes anything in Shopify.{actionsConnected ? '' : ' Bot actions are not connected yet.'}</p>}
        <ul className="grid gap-2">
          {entries.map((entry, index) => (
            <li key={index} className={entry.role === 'user' ? 'justify-self-end rounded-panel bg-ink px-4 py-2 text-[13px] text-white' : entry.role === 'status' ? 'text-[11.5px] text-muted-foreground' : entry.role === 'card' ? '' : 'whitespace-pre-wrap rounded-panel bg-chip px-4 py-2 text-[13px]'}>
              {entry.role === 'card' ? <ConfirmCard card={entry.card} outcome={entry.outcome} onConfirm={() => void confirmCard(index)} /> : entry.content}
            </li>
          ))}
        </ul>
        <div ref={endRef} />
      </div>
      <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void send() }}>
        <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} placeholder="How many orders are waiting for QC?" aria-label="Ask the assistant" className="min-w-0 flex-1 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink" />
        <button type="submit" disabled={busy || !draft.trim()} className={`${pill} bg-ink text-white`}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
    </div>
  )
}

/** A proposed bot action. Confirm once; the outcome replaces the button. */
export function ConfirmCard({ card, outcome, onConfirm }: { card: Card; outcome?: { ok: boolean; text: string }; onConfirm: () => void }) {
  return (
    <div className="rounded-panel border border-face-accent bg-surface p-3">
      <div className="text-[11px] uppercase tracking-[0.11em] text-muted-foreground">{card.label}</div>
      <p className="mt-1 whitespace-pre-wrap text-[13px]">{card.summary}</p>
      {outcome ? <p className={`mt-2 text-[12.5px] ${outcome.ok ? 'text-green' : 'text-amber'}`}>{outcome.text}</p> : (
        <div className="mt-2 flex items-center gap-2"><button type="button" onClick={onConfirm} className={`${pill} bg-ink text-white`}>Confirm</button><span className="text-[11.5px] text-muted-foreground">Nothing is sent until you confirm.</span></div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: The screen and the page**

```tsx
// src/components/home/HomeScreen.tsx
import type { HomeSnapshot } from '@/lib/home/server'
import { ChatPanel } from './ChatPanel'
import { HealthLight } from './HealthLight'
import { NumberTile } from './NumberTile'

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

export function HomeScreen({ lights, numbers, actionsConnected }: HomeSnapshot) {
  const worst = lights.some(light => light.status === 'red') ? 'red' : lights.some(light => light.status === 'amber') ? 'amber' : 'green'
  return (
    <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Qimati</h1>
          <p className="mt-1 text-[13px] text-ink-soft">{worst === 'green' ? 'Everything is answering.' : worst === 'amber' ? 'Something is slow or partly down.' : 'Something is down.'} Checked {clock(lights[0]?.checkedAt ?? numbers.computedAt)} IST.</p>
        </div>
        <span className="rounded-pill bg-chip px-3 py-1 text-[11.5px] text-ink-soft">Numbers as of {clock(numbers.computedAt)}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <NumberTile label="Orders today" value={numbers.ordersToday} />
        <NumberTile label="Paid, unfulfilled" value={numbers.paidUnfulfilled} />
        <NumberTile label="Awaiting QC" value={numbers.awaitingQc} capped={numbers.awaitingQcCapped} href="/qc" />
        <NumberTile label="Awaiting tracking" value={numbers.awaitingTracking} href="/dispatch" />
        <NumberTile label="Open shortages" value={numbers.openShortages} href="/qc/shortages" />
      </div>
      {numbers.problems.length > 0 && <p role="alert" className="mt-3 text-[12px] text-amber">{numbers.problems.join(' · ')}</p>}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h2 className="mb-3 text-[15px] font-medium">Services</h2>
          {lights.length === 0 ? <p className="text-[13px] text-ink-soft">No probes configured.</p> : <ul className="grid gap-2">{lights.map(light => <HealthLight key={light.key} light={light} />)}</ul>}
        </div>
        <div><h2 className="mb-3 text-[15px] font-medium">Ask</h2><ChatPanel actionsConnected={actionsConnected} /></div>
      </div>
    </section>
  )
}
```

```tsx
// src/app/(shell)/home/page.tsx
import { HomeScreen } from '@/components/home/HomeScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { homeSnapshot } from '@/lib/home/server'

export const dynamic = 'force-dynamic'

/** Health lights, five numbers and the assistant. Lights are at most 30 s old and numbers 60 s (in-process caches, D137); every render is authenticated. */
export default async function HomePage() {
  await requireOperator()
  return <HomeScreen {...await homeSnapshot()} />
}
```

- [ ] **Step 6: Run the test, typecheck, lint**

Run: `npx vitest run tests/home-screen-render.test.ts && npm run typecheck && npx eslint src/components/home "src/app/(shell)/home/page.tsx" tests/home-screen-render.test.ts`
Expected: PASS; clean. If the since-time regex fails only because Node's `en-IN` formatting differs ("Sep" vs "Sept", "am" vs "AM"), loosen the regex to `/red since 23 Sep.*3:12.* · 401/i` and say so in the report — the requirement is the "since" time in IST, not a locale spelling.

- [ ] **Step 7: Commit**

```bash
git add src/components/home/HealthLight.tsx src/components/home/NumberTile.tsx src/components/home/ChatPanel.tsx src/components/home/HomeScreen.tsx "src/app/(shell)/home/page.tsx" tests/home-screen-render.test.ts
git commit -m "feat(home): /home — health lights with since times, five number tiles, a chat panel with confirm cards"
```
