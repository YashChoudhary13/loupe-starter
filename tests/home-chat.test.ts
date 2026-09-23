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
  it('a thrown error carries the usage accumulated in the turn so far', async () => {
    const queue = [{ status: 200, body: reply({ content: null, tool_calls: [call('list_orders', { filter: 'today' })] }) }, { status: 402, body: { error: { message: 'Insufficient credits' } } }]
    const fetchImpl = (async () => { const next = queue.shift() ?? { status: 200, body: reply({ content: 'done' }) }; return new Response(JSON.stringify(next.body), { status: next.status }) }) as unknown as typeof fetch
    const error: unknown = await runChatTurn({ apiKey: 'k', model: 'm', system: 's', history: [], message: 'x', tools, actions, ctx, uid: 'u1', secret: SECRET, fetchImpl, emit: () => {} }).catch(e => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Insufficient credits')
    expect((error as { usage?: { toolCalls: number } }).usage).toMatchObject({ toolCalls: 1 })
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
