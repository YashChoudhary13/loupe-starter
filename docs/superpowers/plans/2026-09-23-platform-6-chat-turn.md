# Qimati Platform — Implementation Plan, part 6 of 8 (the chat turn)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here. Task 11 consumes Tasks 9–10 (part 5). The model is called without streaming; progress events, confirm cards and the answer are streamed to the browser by the route in part 7 — a deliberate simplification recorded in D137.

---

### Task 11: The chat turn — OpenRouter tool loop, budgets, system prompt, rate limit

**Files:**
- Create: `src/lib/home/chat.ts`
- Modify: `.env.local.example` (add `HOME_CHAT_MODEL`)
- Test: `tests/home-chat.test.ts`

**Interfaces:**
- Consumes: `READ_TOOLS`-shaped `ToolDef[]`, `runTool`, `toolSpecs`, `ToolContext` (Task 9); `ActionDef`, `ActionParams`, `issueConfirmToken` (Task 10); `ProbeLight`, `HomeNumbers`.
- Produces: `ChatMessage`, `ConfirmCard`, `ChatEvent`, `TurnUsage`, `MAX_TURNS`, `MAX_HISTORY_CHARS`, `MAX_TOOL_CALLS`, `MAX_OUTPUT_TOKENS`, `DEFAULT_MODEL`, `trimHistory(history)`, `systemPrompt({ now, lights, numbers, actions })`, `TurnInput`, `runChatTurn(input)`, `rateLimiter(limit?, windowMs?)`.

- [x] **Step 1: Write the failing test**

```ts
// tests/home-chat.test.ts
import { describe, expect, it } from 'vitest'
import { readConfirmToken, type ActionDef } from '@/lib/home/actions'
import { MAX_HISTORY_CHARS, MAX_TOOL_CALLS, rateLimiter, runChatTurn, systemPrompt, trimHistory, type ChatEvent } from '@/lib/home/chat'
import type { ToolContext, ToolDef } from '@/lib/home/tools'

const SECRET = 'c'.repeat(64)
const runCalls: unknown[] = []
const tools: ToolDef[] = [{ name: 'list_orders', description: 'orders', parameters: { type: 'object', properties: {}, additionalProperties: false }, async run(args) { runCalls.push(args); return [{ name: 'Qimati1', filter: args.filter }] } }]
const actions: ActionDef[] = [{ name: 'send_staff_text', label: 'Send a message to staff', description: 'text', needs: 'staffText', parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  validate: args => typeof args.text === 'string' && args.text ? { ok: true, params: { text: args.text }, summary: args.text } : { ok: false, error: 'Nothing to send.' }, async run() { throw new Error('must never run from a chat turn') } }]
const ctx = {} as ToolContext
const reply = (message: Record<string, unknown>, usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 }) => ({ id: 'r', model: 'anthropic/claude-haiku-4.5', choices: [{ message }], usage })
const call = (name: string, args: Record<string, unknown>, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
function harness(responses: unknown[]) {
  const requests: Record<string, unknown>[] = []; const events: ChatEvent[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => { requests.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(responses.shift() ?? reply({ content: 'done' })), { status: 200 }) }) as unknown as typeof fetch
  const turn = (message = 'hello', history: { role: 'user' | 'assistant'; content: string }[] = []) => runChatTurn({ apiKey: 'k', model: 'anthropic/claude-haiku-4.5', system: 'sys', history, message, tools, actions, ctx, uid: 'u1', secret: SECRET, fetchImpl, now: () => new Date('2026-09-23T10:00:00Z'), emit: event => events.push(event) })
  return { requests, events, turn }
}

describe('a chat turn', () => {
  it('answers plain text and records usage', async () => {
    const h = harness([reply({ content: 'All green.' })])
    expect(await h.turn()).toEqual({ model: 'anthropic/claude-haiku-4.5', promptTokens: 100, completionTokens: 20, cost: 0.001, toolCalls: 0 })
    expect(h.events).toEqual([{ type: 'text', text: 'All green.' }])
    expect(h.requests[0]).toMatchObject({ model: 'anthropic/claude-haiku-4.5', max_tokens: 4000, stream: false, tool_choice: 'auto', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] })
    expect((h.requests[0].tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['list_orders', 'send_staff_text'])
  })
  it('content that arrives as an array of parts is joined into plain text', async () => {
    const h = harness([reply({ content: [{ type: 'text', text: 'All ' }, { type: 'text', text: 'green.' }] })])
    await h.turn()
    expect(h.events).toEqual([{ type: 'text', text: 'All green.' }])
  })
  it('runs a read tool, feeds the result back, and emits a status line', async () => {
    const h = harness([reply({ content: null, tool_calls: [call('list_orders', { filter: 'today' })] }), reply({ content: 'One order today: Qimati1.' })])
    expect((await h.turn()).toolCalls).toBe(1)
    expect(h.events).toEqual([{ type: 'status', text: 'Checking list orders…' }, { type: 'text', text: 'One order today: Qimati1.' }])
    const second = h.requests[1].messages as Record<string, unknown>[]
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'c1' })] })
    expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '[{"name":"Qimati1","filter":"today"}]' })
  })
  it('an action becomes a confirm card bound to the user and is never executed here', async () => {
    const h = harness([reply({ content: null, tool_calls: [call('send_staff_text', { text: 'Pack faster' })] }), reply({ content: 'Tap Confirm to send it.' })])
    await h.turn()
    const card = h.events.find(event => event.type === 'confirm')
    expect(card).toMatchObject({ type: 'confirm', card: { action: 'send_staff_text', label: 'Send a message to staff', summary: 'Pack faster', params: { text: 'Pack faster' } } })
    expect(readConfirmToken(SECRET, card && card.type === 'confirm' ? card.card.token : '', 'u1', Math.floor(Date.parse('2026-09-23T10:00:00Z') / 1000))).toMatchObject({ ok: true, payload: { action: 'send_staff_text' } })
    expect((h.requests[1].messages as Record<string, unknown>[]).at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('confirm card') })
  })
  it('invalid action parameters go back to the model as an error, with no card', async () => {
    const h = harness([reply({ content: null, tool_calls: [call('send_staff_text', { text: '' })] }), reply({ content: 'I need a message.' })])
    await h.turn()
    expect(h.events.some(event => event.type === 'confirm')).toBe(false)
    expect((h.requests[1].messages as Record<string, unknown>[]).at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"error":"Nothing to send."}' })
  })
  it('malformed tool arguments become an error without running the tool or validating an action', async () => {
    runCalls.length = 0
    const h = harness([reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_orders', arguments: '{not json' } }] }), reply({ content: 'Fixed.' })])
    await h.turn()
    expect(runCalls).toHaveLength(0)
    expect((h.requests[1].messages as Record<string, unknown>[]).at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"error":"Malformed tool arguments; send a JSON object."}' })
  })
  it(`stops running tools after ${MAX_TOOL_CALLS} calls and forces a final answer`, async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, n) => call('list_orders', {}, `c${n}`))
    const h = harness([reply({ content: null, tool_calls: calls }), reply({ content: 'Enough.' })])
    expect((await h.turn()).toolCalls).toBe(MAX_TOOL_CALLS)
    const toolMessages = (h.requests[1].messages as { role: string; content: string }[]).filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(MAX_TOOL_CALLS + 1); expect(toolMessages.at(-1)?.content).toMatch(/budget/)
    expect(h.requests[1].tool_choice).toBe('none'); expect(h.events.at(-1)).toEqual({ type: 'text', text: 'Enough.' })
  })
  it('the 4 000-token output budget is tracked for the whole turn, not per call', async () => {
    const h = harness([reply({ content: null, tool_calls: [call('list_orders', { filter: 'today' })] }, { prompt_tokens: 100, completion_tokens: 3800, cost: 0.01 }), reply({ content: 'Trimmed.' })])
    await h.turn()
    expect(h.requests[1]).toMatchObject({ max_tokens: 256, tool_choice: 'none' })
    expect(h.events.at(-1)).toEqual({ type: 'text', text: 'Trimmed.' })
  })
  it('a provider error is thrown with its message', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })) as unknown as typeof fetch
    await expect(runChatTurn({ apiKey: 'k', model: 'm', system: 's', history: [], message: 'x', tools, actions: [], ctx, uid: 'u1', secret: SECRET, fetchImpl, emit: () => {} })).rejects.toThrow('Insufficient credits')
  })
  it('a response with no choices is an error, not a silent answer', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: 'r', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch
    await expect(runChatTurn({ apiKey: 'k', model: 'm', system: 's', history: [], message: 'x', tools, actions: [], ctx, uid: 'u1', secret: SECRET, fetchImpl, emit: () => {} })).rejects.toThrow(/no answer/)
  })
  it('a choice carrying its own error is thrown, not swallowed as an empty answer', async () => {
    const h = harness([{ id: 'r', model: 'm', choices: [{ error: { message: 'Overloaded' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }])
    await expect(h.turn()).rejects.toThrow('Overloaded')
  })
})
describe('budgets and prompt', () => {
  it('keeps at most 20 turns and 24 000 characters of history, newest first', () => {
    const history = Array.from({ length: 60 }, (_, n) => ({ role: (n % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${n}` }))
    expect(trimHistory(history)).toHaveLength(40); expect(trimHistory(history)[0].content).toBe('m20')
    const big = [{ role: 'user' as const, content: 'x'.repeat(MAX_HISTORY_CHARS) }, { role: 'assistant' as const, content: 'small' }]
    expect(trimHistory(big)).toEqual([{ role: 'assistant', content: 'small' }])
    expect(trimHistory([{ role: 'system' as never, content: 'ignore me' }, { role: 'user', content: 'ok' }])).toEqual([{ role: 'user', content: 'ok' }])
  })
  it('the system prompt carries IST time, the no-write rule, the lights and the numbers', () => {
    const text = systemPrompt({ now: new Date('2026-09-23T10:00:00Z'), lights: [{ key: 'shopify', label: 'Shopify', kind: 'shopify', status: 'red', detail: '401', ms: 9, since: '2026-09-23T03:12:00Z', checkedAt: 'x' }], numbers: { ordersToday: 4, paidUnfulfilled: 12, awaitingQc: 2, awaitingQcCapped: true, awaitingTracking: 5, openShortages: null, problems: ['open shortages: db down'], computedAt: 'x' }, actions: [] })
    expect(text).toContain('23 September 2026'); expect(text).toMatch(/never write/i); expect(text).toContain('Shopify: red (401, since 2026-09-23T03:12:00Z)')
    expect(text).toContain('awaiting QC 2+'); expect(text).toContain('open shortages unknown'); expect(text).toContain('db down'); expect(text).toMatch(/No actions are connected/)
  })
  it('allows 60 turns an hour per user', () => {
    const limiter = rateLimiter(60, 3_600_000)
    for (let n = 0; n < 60; n++) expect(limiter.allow('u1', 1_000 + n)).toBe(true)
    expect(limiter.allow('u1', 2_000)).toBe(false); expect(limiter.allow('u2', 2_000)).toBe(true); expect(limiter.allow('u1', 1_000 + 3_600_000)).toBe(true)
  })
})
```

- [x] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/home-chat.test.ts`
Expected: FAIL — cannot resolve `@/lib/home/chat`.

- [x] **Step 3: Implement**

```ts
// src/lib/home/chat.ts
import { issueConfirmToken, type ActionDef, type ActionParams } from './actions'
import type { HomeNumbers } from './numbers'
import type { ProbeLight } from './probes'
import { runTool, toolSpecs, type ToolContext, type ToolDef } from './tools'

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ConfirmCard { action: string; label: string; summary: string; params: ActionParams; token: string }
export type ChatEvent = { type: 'status'; text: string } | { type: 'text'; text: string } | { type: 'confirm'; card: ConfirmCard } | { type: 'error'; text: string } | { type: 'done'; usage: TurnUsage }
export interface TurnUsage { model: string; promptTokens: number | null; completionTokens: number | null; cost: number | null; toolCalls: number }
export const MAX_TURNS = 20, MAX_HISTORY_CHARS = 24_000, MAX_TOOL_CALLS = 6, MAX_OUTPUT_TOKENS = 4_000
export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'

/** The tab's history, capped at 20 turns and roughly 6 000 tokens (24 000 characters), oldest dropped first. */
export function trimHistory(history: readonly ChatMessage[]): ChatMessage[] {
  let kept = history.filter(item => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-MAX_TURNS * 2)
  while (kept.length && kept.reduce((sum, item) => sum + item.content.length, 0) > MAX_HISTORY_CHARS) kept = kept.slice(1)
  return kept.map(item => ({ role: item.role, content: item.content.slice(0, 8_000) }))
}

export function systemPrompt(input: { now: Date; lights: readonly ProbeLight[]; numbers: HomeNumbers; actions: readonly ActionDef[] }): string {
  const ist = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(input.now)
  const lights = input.lights.map(light => `${light.label}: ${light.status}${light.status === 'green' ? '' : ` (${light.detail}, since ${light.since})`}`).join('\n')
  const n = input.numbers, num = (value: number | null) => (value === null ? 'unknown' : String(value))
  return [
    `You are the Qimati operations assistant on the Home dashboard. It is ${ist} in Jaipur (IST).`,
    'Rules: you read live facts and answer plainly, in a sentence or two unless a list is asked for. You never write to Shopify, the website, products, discounts, customers or orders, and you have no tool that can. You never see or repeat a customer name, phone number or address. When a number is "unknown", say that check failed rather than guessing.',
    input.actions.length ? `The only actions you may propose are ${input.actions.map(action => action.name).join(', ')}; each becomes a confirm card the operator taps, and you never execute anything yourself.` : 'No actions are connected yet: you can only read.',
    `Health lights:\n${lights || 'none configured'}`,
    `Numbers (computed ${n.computedAt}): orders today ${num(n.ordersToday)}, paid unfulfilled ${num(n.paidUnfulfilled)}, awaiting QC ${num(n.awaitingQc)}${n.awaitingQcCapped ? '+' : ''}, awaiting tracking ${num(n.awaitingTracking)}, open shortages ${num(n.openShortages)}.`,
    n.problems.length ? `Checks that failed: ${n.problems.join('; ')}` : '',
  ].filter(Boolean).join('\n\n')
}

interface ToolCall { id: string; type?: string; function: { name: string; arguments: string } }
type ContentPart = { type?: string; text?: string }
interface Completion { model?: string; choices?: { message?: { content?: string | ContentPart[] | null; tool_calls?: ToolCall[] }; error?: { message?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | string }; error?: { message?: string } }
export interface TurnInput { apiKey: string; model: string; system: string; history: readonly ChatMessage[]; message: string; tools: readonly ToolDef[]; actions: readonly ActionDef[]; ctx: ToolContext; uid: string; secret: string; fetchImpl?: typeof fetch; now?: () => Date; emit(event: ChatEvent): void }
const parseArgs = (raw: string): Record<string, unknown> | null => { try { const value: unknown = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null } catch { return null } }
/** OpenRouter content is a string for most models but some return an array of parts (`[{ type: 'text', text: '…' }, …]`); either way we want plain text. */
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string').map(part => (part as { text: string }).text).join('') : ''

/** One user message → at most 6 tool calls → one answer. Read tools run here; an action only becomes a confirm card. Model calls are not streamed; progress is. */
export async function runChatTurn(input: TurnInput): Promise<TurnUsage> {
  const doFetch = input.fetchImpl ?? fetch, now = input.now ?? (() => new Date())
  const messages: Record<string, unknown>[] = [{ role: 'system', content: input.system }, ...trimHistory(input.history), { role: 'user', content: input.message.slice(0, 8_000) }]
  const specs = [...toolSpecs(input.tools), ...toolSpecs(input.actions)]
  const usage: TurnUsage = { model: input.model, promptTokens: null, completionTokens: null, cost: null, toolCalls: 0 }
  const add = (u: Completion['usage']) => {
    if (!u) return
    usage.promptTokens = (usage.promptTokens ?? 0) + (u.prompt_tokens ?? 0); usage.completionTokens = (usage.completionTokens ?? 0) + (u.completion_tokens ?? 0)
    const cost = Number(u.cost); if (u.cost !== undefined && Number.isFinite(cost)) usage.cost = (usage.cost ?? 0) + cost
  }
  for (let round = 0; round <= MAX_TOOL_CALLS; round++) {
    // The 4 000-token budget is for the whole turn, not per call: track what's left and force a final answer once it runs low, same as running out of tool calls.
    const remaining = MAX_OUTPUT_TOKENS - (usage.completionTokens ?? 0), exhausted = usage.toolCalls >= MAX_TOOL_CALLS || remaining < 512
    const response = await doFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Qimati Home' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: input.model, messages, ...(specs.length ? { tools: specs, tool_choice: exhausted ? 'none' : 'auto' } : {}), max_tokens: Math.max(256, remaining), stream: false }) })
    const body = (await response.json().catch(() => ({}))) as Completion
    if (!response.ok) throw new Error(body.error?.message ?? `The model answered ${response.status}.`)
    add(body.usage); if (body.model) usage.model = body.model
    const choice = body.choices?.[0]
    if (choice?.error) throw new Error(choice.error.message ?? 'The model returned an error.')
    if (!choice?.message) throw new Error(body.error?.message ?? 'The model returned no answer.')
    const reply = choice.message
    const calls = (reply.tool_calls ?? []).filter(item => item?.function?.name)
    if (!calls.length || exhausted) { input.emit({ type: 'text', text: textOf(reply.content).trim() || 'I have nothing to add.' }); return usage }
    messages.push({ role: 'assistant', content: textOf(reply.content) || null, tool_calls: calls })
    for (const item of calls) {
      const args = parseArgs(item.function.arguments), action = input.actions.find(candidate => candidate.name === item.function.name)
      let result: string
      if (usage.toolCalls >= MAX_TOOL_CALLS) result = JSON.stringify({ error: 'The tool budget for this turn is spent; answer with what you have.' })
      else if (args === null) { usage.toolCalls++; result = JSON.stringify({ error: 'Malformed tool arguments; send a JSON object.' }) }
      else if (action) {
        usage.toolCalls++
        const verdict = action.validate(args, now())
        if (verdict.ok) {
          const token = issueConfirmToken(input.secret, { uid: input.uid, action: action.name, params: verdict.params }, Math.floor(now().getTime() / 1000))
          input.emit({ type: 'confirm', card: { action: action.name, label: action.label, summary: verdict.summary, params: verdict.params, token } })
          result = JSON.stringify({ proposed: true, note: 'Shown to the operator as a confirm card. Do not call this again; tell the operator to tap Confirm.' })
        } else result = JSON.stringify({ error: verdict.error })
      } else {
        usage.toolCalls++
        input.emit({ type: 'status', text: `Checking ${item.function.name.replaceAll('_', ' ')}…` })
        result = await runTool(input.tools, item.function.name, args, input.ctx)
      }
      messages.push({ role: 'tool', tool_call_id: item.id, content: result })
    }
  }
  return usage
}

// ponytail: per-process sliding window; one Node process serves the platform.
export function rateLimiter(limit = 60, windowMs = 3_600_000) {
  const hits = new Map<string, number[]>()
  return { allow(key: string, now = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter(at => now - at < windowMs)
    if (recent.length >= limit) { hits.set(key, recent); return false }
    recent.push(now); hits.set(key, recent); return true
  } }
}
```
Append to `.env.local.example`, under the Home dashboard section: `HOME_CHAT_MODEL=anthropic/claude-haiku-4.5` with the comment `# The assistant's text model through OpenRouter (tool calling required). Reads only.`

- [x] **Step 4: Run the test, typecheck, lint**

Run: `npx vitest run tests/home-chat.test.ts && npm run typecheck && npx eslint src/lib/home/chat.ts tests/home-chat.test.ts`
Expected: PASS; clean. `replaceAll` needs `lib: es2021`; `tsconfig` has `esnext`, so it compiles.

- [x] **Step 5: Commit**

```bash
git add src/lib/home/chat.ts .env.local.example tests/home-chat.test.ts
git commit -m "feat(home): the chat turn — OpenRouter tool loop with a six-call budget, actions become confirm cards, 60 turns an hour"
```

- [x] **Step 6: Fix round 1 (review)**

Four defects found in review, fixed in `src/lib/home/chat.ts` and `tests/home-chat.test.ts` (both blocks above already reflect the fix):
1. The `max_tokens: MAX_OUTPUT_TOKENS` budget was sent on every model call, not tracked per turn — up to seven calls could emit 28 000 output tokens against a 4 000 stated budget. Fixed by computing `remaining = MAX_OUTPUT_TOKENS - (usage.completionTokens ?? 0)` each round, sending `max_tokens: Math.max(256, remaining)`, and folding `remaining < 512` into `exhausted` alongside the tool-call budget.
2. A malformed 200 (no `choices`, or a choice carrying its own `error`) fell through to `'I have nothing to add.'` with a normal usage line — a failure read out as an all-clear. Fixed by throwing on `choice?.error` and on a missing `choice?.message` before extracting the reply. The error check runs before the missing-message check (not after, as first proposed) — checking "no message" first would report "The model returned no answer" for a choice shaped `{ error: { message: 'Overloaded' } }`, which has no `message` key, masking the real error; both of this fix's own tests (a choiceless body, and a choice carrying only `error`) require the error check to run first.
3. `reply.content` can arrive as an array of parts (`[{ type: 'text', text: '…' }, …]`) instead of a string; `.trim()` on that would throw. Added `textOf()` to normalise either shape to plain text, used for both the emitted text and the assistant message pushed back for the next round.
4. Malformed tool-call arguments (invalid JSON, or valid JSON that isn't an object) silently became `{}` and the tool ran on defaults. `parseArgs` now returns `null` in both cases; a `null` result short-circuits to a `{"error":"Malformed tool arguments; send a JSON object."}` tool message without calling `runTool` or `action.validate`, while still counting one tool call against the turn's budget.

Run: `npx vitest run tests/home-chat.test.ts && npm run typecheck && npx eslint src/lib/home/chat.ts tests/home-chat.test.ts`
Expected: PASS (14 tests); clean.

```bash
git add src/lib/home/chat.ts tests/home-chat.test.ts docs/superpowers/plans/2026-09-23-platform-6-chat-turn.md
git commit -m "fix(home): the output budget is per turn, a failed 200 is an error not an answer, text parts and malformed tool arguments are handled"
```
