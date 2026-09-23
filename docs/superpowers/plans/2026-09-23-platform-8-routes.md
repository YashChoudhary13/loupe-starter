# Qimati Platform — Implementation Plan, part 8 of 10 (chat and action routes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here. Task 12 consumes parts 2–6.

---

### Task 12: `POST /api/home/chat` (NDJSON stream) and `POST /api/home/action` (confirm)

**Files:**
- Create: `src/app/api/home/chat/route.ts`, `src/app/api/home/action/route.ts`, `src/lib/home/body.ts`
- Test: `tests/home-routes.test.ts`

**Interfaces:**
- Consumes: `requireOperatorForAction`, `actorFor`, `NotAuthorisedError`, `Operator`; `isOwnOrigin` (Task 2); `availableActions`, `botConfig`, `consumeNonce`, `readConfirmToken` (Task 10); `DEFAULT_MODEL`, `rateLimiter`, `runChatTurn`, `systemPrompt`, `ChatEvent`, `ChatMessage` (Task 11); `homeSnapshot`, `homeToolContext` (Tasks 8–10); `READ_TOOLS` (Task 9); `postWebhook` (Task 6); `supabaseServer`.
- Produces: the two routes. Chat request `{ message: string; messages?: ChatMessage[] }` → `application/x-ndjson`, one `ChatEvent` per line, ending with `done` or `error`. Action request `{ token: string }` → `{ ok: boolean; text: string }` (200 / 502) or `{ ok: false; error }` (400 / 401 / 403 / 409 / 413 / 415).

- [ ] **Step 1: Write the failing test**

```ts
// tests/home-routes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ operator: vi.fn(), turn: vi.fn(), events: [] as unknown[], config: { report: null as string | null, staffText: null as string | null, secret: null as string | null }, posts: [] as unknown[], insertThrows: false }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorForAction: mocks.operator, actorFor: (operator: { email: string }) => operator.email, NotAuthorisedError: class extends Error {} }))
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://qimati-eng.site', authSessionSecret: 'd'.repeat(64), openRouterApiKey: 'or-key' } }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: () => ({ insert: async (row: unknown) => { if (mocks.insertThrows) throw new Error('db down'); mocks.events.push(row); return { error: null } } }) }) }))
vi.mock('@/lib/home/server', () => ({ homeSnapshot: async () => ({ lights: [], numbers: { ordersToday: 1, paidUnfulfilled: 2, awaitingQc: 3, awaitingQcCapped: false, awaitingTracking: 4, openShortages: 5, problems: [], computedAt: 'x' }, actionsConnected: false }), homeToolContext: () => ({}) }))
vi.mock('@/lib/home/chat', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/home/chat')>()), runChatTurn: mocks.turn }))
vi.mock('@/lib/home/actions', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/home/actions')>()), botConfig: () => mocks.config }))
vi.mock('@/lib/home/n8n', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/home/n8n')>()), postWebhook: async (url: string, secret: string, body: unknown) => { mocks.posts.push({ url, secret, body }); return { status: 200, text: '' } } }))
import { NotAuthorisedError } from '@/lib/auth/authorize'
import { issueConfirmToken, resetNonces } from '@/lib/home/actions'
import { POST as chat } from '@/app/api/home/chat/route'
import { POST as confirm } from '@/app/api/home/action/route'

const SECRET = 'd'.repeat(64)
const request = (path: string, body: unknown, origin = 'https://qimati-eng.site', extraHeaders: Record<string, string> = {}) => new Request(`https://qimati-eng.site${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const lines = async (response: Response) => (await response.text()).trim().split('\n').map(line => JSON.parse(line))
beforeEach(() => {
  vi.clearAllMocks(); resetNonces(); mocks.events.length = 0; mocks.posts.length = 0; mocks.config = { report: null, staffText: null, secret: null }; mocks.insertThrows = false
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
  it('rejects an oversized or non-object body before the turn runs', async () => {
    expect((await chat(request('/api/home/chat', { message: 'hi' }, 'https://qimati-eng.site', { 'content-length': '70000' }))).status).toBe(413)
    expect((await chat(request('/api/home/chat', { message: 'x'.repeat(70_000) }))).status).toBe(413)
    expect((await chat(request('/api/home/chat', 'null'))).status).toBe(400)
    expect(mocks.turn).not.toHaveBeenCalled()
  })
  it('streams the turn as NDJSON, ends with done, and records the cost line', async () => {
    const response = await chat(request('/api/home/chat', { message: 'How are we?', messages: [{ role: 'user', content: 'earlier' }, { role: 'system', content: 'ignored' }] }))
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/x-ndjson'); expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(await lines(response)).toEqual([{ type: 'text', text: 'All green.' }, { type: 'done', usage: { model: 'm', promptTokens: 10, completionTokens: 5, cost: 0.001, toolCalls: 0 } }])
    expect(mocks.turn.mock.calls[0][0]).toMatchObject({ uid: 'u1', message: 'How are we?', history: [{ role: 'user', content: 'earlier' }], apiKey: 'or-key', model: 'anthropic/claude-haiku-4.5', actions: [] })
    expect(mocks.turn.mock.calls[0][0].system).toContain('never write')
    expect(mocks.events[0]).toMatchObject({ event: 'home.chat_turn', actor: 'owner@example.test', detail: { toolCalls: 0, cost: 0.001, ok: true } })
  })
  it('a supabase failure while logging the turn does not stop the stream', async () => {
    mocks.insertThrows = true
    const response = await chat(request('/api/home/chat', { message: 'hi' }))
    expect(await lines(response)).toEqual([{ type: 'text', text: 'All green.' }, { type: 'done', usage: { model: 'm', promptTokens: 10, completionTokens: 5, cost: 0.001, toolCalls: 0 } }])
  })
  it('turns a failed turn into an error event, never a crash, and still logs the failure', async () => {
    mocks.turn.mockRejectedValueOnce(new Error('Insufficient credits'))
    expect(await lines(await chat(request('/api/home/chat', { message: 'hi' })))).toEqual([{ type: 'error', text: 'Insufficient credits' }])
    expect(mocks.events[0]).toMatchObject({ event: 'home.chat_turn', detail: { ok: false, error: 'Insufficient credits' } })
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
  it('rejects an oversized or non-object body before touching the token', async () => {
    expect((await confirm(request('/api/home/action', { token: 'x' }, 'https://qimati-eng.site', { 'content-length': '9000' }))).status).toBe(413)
    expect((await confirm(request('/api/home/action', { token: 'x'.repeat(9_000) }))).status).toBe(413)
    expect((await confirm(request('/api/home/action', 'null'))).status).toBe(400)
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
import { readBoundedBody } from '@/lib/home/body'
import { DEFAULT_MODEL, rateLimiter, runChatTurn, systemPrompt, type ChatEvent, type ChatMessage, type TurnUsage } from '@/lib/home/chat'
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
  try { operator = await requireOperatorForAction() } catch (error) {
    if (error instanceof NotAuthorisedError) return fail(401, 'Sign in again to chat.')
    console.error('home route auth failed:', error)
    return fail(500, 'Sign in again to chat.')
  }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to chat.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await readBoundedBody(request, 65_536)
  if (text === null) return fail(413, 'That conversation is too long. Start a new one.')
  let body: { messages?: unknown; message?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  if (!body || typeof body !== 'object') return fail(400, 'Send JSON.')
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return fail(400, 'Say something first.')
  const history = (Array.isArray(body.messages) ? body.messages : []).filter(isMessage)
  if (!limiter.allow(operator.id)) return fail(429, 'Sixty questions an hour is the limit here. Try again later.')
  const model = process.env.HOME_CHAT_MODEL?.trim() || DEFAULT_MODEL
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      // A failed insert must never take down the stream — it's a best-effort cost/audit line, logged in its own try/catch on both paths below.
      const log = async (detail: Record<string, unknown>) => {
        try {
          const { error } = await supabaseServer().from('events').insert({ entity_type: 'home_chat', event: 'home.chat_turn', detail, actor: actorFor(operator) })
          if (error) console.warn('home.chat_turn not recorded:', error.message)
        } catch (logError) { console.warn('home.chat_turn not recorded:', logError) }
      }
      try {
        const snapshot = await homeSnapshot(), actions = availableActions(botConfig())
        const usage = await runChatTurn({ apiKey: serverEnv.openRouterApiKey, model, system: systemPrompt({ now: new Date(), lights: snapshot.lights, numbers: snapshot.numbers, actions }), history, message, tools: READ_TOOLS, actions, ctx: homeToolContext(), uid: operator.id, secret: serverEnv.authSessionSecret, emit })
        await log({ ...usage, ok: true })
        emit({ type: 'done', usage })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The assistant failed.'
        console.warn('home chat turn failed:', reason)
        const usage = (error as { usage?: TurnUsage })?.usage ?? { model, promptTokens: null, completionTokens: null, cost: null, toolCalls: 0 }
        await log({ ...usage, ok: false, error: reason })
        emit({ type: 'error', text: reason })
      } finally { controller.close() }
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
import { readBoundedBody } from '@/lib/home/body'
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
  try { operator = await requireOperatorForAction() } catch (error) {
    if (error instanceof NotAuthorisedError) return fail(401, 'Sign in again.')
    console.error('home route auth failed:', error)
    return fail(500, 'Sign in again.')
  }
  if (!isOwnOrigin(request.headers.get('origin'))) return fail(403, 'Open the Home dashboard to confirm.')
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'Send JSON.')
  const text = await readBoundedBody(request, 8_192)
  if (text === null) return fail(413, 'Request too large.')
  let body: { token?: unknown }
  try { body = JSON.parse(text) } catch { return fail(400, 'Send JSON.') }
  if (!body || typeof body !== 'object') return fail(400, 'Send JSON.')
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

- [x] **Step 7: Fix round 1 (review)**

Two Important findings plus three one-line guards, all defects in this task's own code, fixed in `src/app/api/home/chat/route.ts`, `src/app/api/home/action/route.ts`, `src/lib/home/body.ts` (new — added to this task's Files above), `src/lib/home/chat.ts` (Task 11; see its own Step 7) and `tests/home-routes.test.ts`, `tests/home-chat.test.ts` (both blocks above already reflect the fix):
1. The 65 536 / 8 192-byte body cap ran only after `request.text()` had already buffered the whole body, and compared against `.length` — UTF-16 units, not bytes. Fixed by `src/lib/home/body.ts`, exporting `readBoundedBody(request, maxBytes)`: it refuses at once on a `content-length` header already over the limit, and refuses mid-stream — cancelling the reader — the moment the running byte total exceeds it, before ever assembling the full string. Both routes call it in place of `request.text()`.
2. A turn that threw (a bad provider response, a choice with no message) left no `home.chat_turn` row and nothing in the server log — the operator saw an error line and the failure vanished. Fixed on both ends: `runChatTurn` (Task 11) now throws `Object.assign(new Error(message), { usage })` from every one of its three throw sites, so the usage accumulated up to the failure travels with the error; this route's `catch` reads `(error as { usage?: TurnUsage }).usage`, falling back to an all-null shape carrying the resolved model string when the turn never returned any usage at all, `console.warn`s the failure, and logs `home.chat_turn` with `ok: false` and the error message before emitting the `error` event. The success path now logs `ok: true` too. Both log calls run through a shared `log()` closure with its own try/catch, so a Supabase failure while logging can never take down the stream — it still reaches `done`.
3. `JSON.parse('null')` parses cleanly to `null`; every field access after it (`body.message`, `body.token`) was one step from reading a property off `null` or silently coercing to `undefined` instead of being refused outright. Both routes now check `if (!body || typeof body !== 'object') return fail(400, 'Send JSON.')` right after parsing.
4. Neither route logged anything when `requireOperatorForAction()` rejected with something other than `NotAuthorisedError` — a real lookup failure (Supabase down, say) just returned an opaque 500 with no trace. Both routes now `console.error('home route auth failed:', error)` before that 500 branch; the routine 401 path (a session that simply ended) stays unlogged.

Run: `npx vitest run tests/home-routes.test.ts tests/home-chat.test.ts && npm run typecheck && npx eslint src/app/api/home/chat/route.ts src/app/api/home/action/route.ts src/lib/home/body.ts src/lib/home/chat.ts tests/home-routes.test.ts tests/home-chat.test.ts`
Expected: PASS (25 tests across both files); clean.

```bash
git add src/app/api/home/chat/route.ts src/app/api/home/action/route.ts src/lib/home/body.ts src/lib/home/chat.ts tests/home-routes.test.ts tests/home-chat.test.ts docs/superpowers/plans/2026-09-23-platform-8-routes.md docs/superpowers/plans/2026-09-23-platform-7-chat-turn.md
git commit -m "fix(home): bodies are capped before they are read, a failed turn still writes its cost line, a null body is a 400"
```
