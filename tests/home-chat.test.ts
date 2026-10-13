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
const MODEL = 'claude-haiku-4-5'
const text = (value: string) => ({ type: 'text', text: value })
const call = (name: string, input: unknown, id = 'c1') => ({ type: 'tool_use', id, name, input })
const reply = (content: { type: string }[], usage = { input_tokens: 100, output_tokens: 20 }, stop_reason = content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content, stop_reason, stop_sequence: null, usage })
// The SDK only parses a body it is told is JSON.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noCredit = { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low' } }
const lastResults = (request: Record<string, unknown>) => (request.messages as { role: string; content: { type: string; tool_use_id: string; content: string }[] }[]).at(-1)
function harness(responses: unknown[], workspaceId?: string) {
  const requests: Record<string, unknown>[] = []; const headers: Headers[] = []; const events: ChatEvent[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => { requests.push(JSON.parse(String(init?.body))); headers.push(new Headers(init?.headers)); return json(responses.shift() ?? reply([text('done')])) }) as unknown as typeof fetch
  const turn = (message = 'hello', history: { role: 'user' | 'assistant'; content: string }[] = []) => runChatTurn({ apiKey: 'k', workspaceId, model: MODEL, system: 'sys', history, message, tools, actions, ctx, uid: 'u1', secret: SECRET, fetchImpl, now: () => new Date('2026-09-23T10:00:00Z'), emit: event => events.push(event) })
  return { requests, headers, events, turn }
}

describe('a chat turn', () => {
  it('answers plain text and records usage, with the cost worked out from the token counts', async () => {
    const h = harness([reply([text('All green.')])])
    expect(await h.turn()).toEqual({ model: MODEL, promptTokens: 100, completionTokens: 20, cost: 0.0002, toolCalls: 0 })
    expect(h.events).toEqual([{ type: 'text', text: 'All green.' }])
    expect(h.requests[0]).toMatchObject({ model: MODEL, max_tokens: 4000, system: 'sys', tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'hello' }] })
    expect((h.requests[0].tools as { name: string }[]).map(tool => tool.name)).toEqual(['list_orders', 'send_staff_text'])
    expect(h.headers[0].get('x-api-key')).toBe('k'); expect(h.headers[0].get('anthropic-workspace-id')).toBeNull()
  })
  it('names the workspace on every call when the key is not tied to one', async () => {
    const h = harness([reply([call('list_orders', {})]), reply([text('Done.')])], 'wrkspc_test')
    await h.turn()
    expect(h.headers.map(sent => sent.get('anthropic-workspace-id'))).toEqual(['wrkspc_test', 'wrkspc_test'])
  })
  it('a model outside the price table logs a null cost', async () => {
    const h = harness([{ ...reply([text('Hi.')]), model: 'claude-something-new' }])
    expect(await h.turn()).toMatchObject({ model: 'claude-something-new', cost: null })
  })
  it('several text blocks are joined into plain text', async () => {
    const h = harness([reply([text('All '), text('green.')])])
    await h.turn()
    expect(h.events).toEqual([{ type: 'text', text: 'All green.' }])
  })
  it('runs a read tool, feeds the result back, and emits a status line', async () => {
    const h = harness([reply([call('list_orders', { filter: 'today' })]), reply([text('One order today: Qimati1.')])])
    expect((await h.turn()).toolCalls).toBe(1)
    expect(h.events).toEqual([{ type: 'status', text: 'Checking list orders…' }, { type: 'text', text: 'One order today: Qimati1.' }])
    const second = h.requests[1].messages as Record<string, unknown>[]
    expect(second.at(-2)).toMatchObject({ role: 'assistant', content: [expect.objectContaining({ type: 'tool_use', id: 'c1' })] })
    expect(second.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '[{"name":"Qimati1","filter":"today"}]' }] })
  })
  it('an action becomes a confirm card bound to the user and is never executed here', async () => {
    const h = harness([reply([call('send_staff_text', { text: 'Pack faster' })]), reply([text('Tap Confirm to send it.')])])
    await h.turn()
    const card = h.events.find(event => event.type === 'confirm')
    expect(card).toMatchObject({ type: 'confirm', card: { action: 'send_staff_text', label: 'Send a message to staff', summary: 'Pack faster', params: { text: 'Pack faster' } } })
    expect(readConfirmToken(SECRET, card && card.type === 'confirm' ? card.card.token : '', 'u1', Math.floor(Date.parse('2026-09-23T10:00:00Z') / 1000))).toMatchObject({ ok: true, payload: { action: 'send_staff_text' } })
    expect(lastResults(h.requests[1])?.content[0]).toMatchObject({ type: 'tool_result', content: expect.stringContaining('confirm card') })
  })
  it('invalid action parameters go back to the model as an error, with no card', async () => {
    const h = harness([reply([call('send_staff_text', { text: '' })]), reply([text('I need a message.')])])
    await h.turn()
    expect(h.events.some(event => event.type === 'confirm')).toBe(false)
    expect(lastResults(h.requests[1])?.content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: '{"error":"Nothing to send."}' }])
  })
  it('tool arguments that are not an object become an error without running the tool or validating an action', async () => {
    runCalls.length = 0
    const h = harness([reply([call('list_orders', 'today')]), reply([text('Fixed.')])])
    await h.turn()
    expect(runCalls).toHaveLength(0)
    expect(lastResults(h.requests[1])?.content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: '{"error":"Malformed tool arguments; send a JSON object."}' }])
  })
  it(`stops running tools after ${MAX_TOOL_CALLS} calls and forces a final answer`, async () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, n) => call('list_orders', {}, `c${n}`))
    const h = harness([reply(calls), reply([text('Enough.')])])
    expect((await h.turn()).toolCalls).toBe(MAX_TOOL_CALLS)
    const results = lastResults(h.requests[1])?.content ?? []
    expect(results).toHaveLength(MAX_TOOL_CALLS + 1); expect(results.at(-1)?.content).toMatch(/budget/)
    expect(h.requests[1].tool_choice).toEqual({ type: 'none' }); expect(h.events.at(-1)).toEqual({ type: 'text', text: 'Enough.' })
  })
  it('the 4 000-token output budget is tracked for the whole turn, not per call', async () => {
    const h = harness([reply([call('list_orders', { filter: 'today' })], { input_tokens: 100, output_tokens: 3800 }), reply([text('Trimmed.')])])
    await h.turn()
    expect(h.requests[1]).toMatchObject({ max_tokens: 256, tool_choice: { type: 'none' } })
    expect(h.events.at(-1)).toEqual({ type: 'text', text: 'Trimmed.' })
  })
  it('a provider error is thrown with the sentence the API gave', async () => {
    const fetchImpl = (async () => json(noCredit, 402)) as unknown as typeof fetch
    await expect(runChatTurn({ apiKey: 'k', model: 'm', system: 's', history: [], message: 'x', tools, actions: [], ctx, uid: 'u1', secret: SECRET, fetchImpl, emit: () => {} })).rejects.toThrow(/^Your credit balance is too low$/)
  })
  it('a thrown error carries the usage accumulated in the turn so far', async () => {
    const queue = [json(reply([call('list_orders', { filter: 'today' })])), json(noCredit, 402)]
    const fetchImpl = (async () => queue.shift() ?? json(reply([text('done')]))) as unknown as typeof fetch
    const error: unknown = await runChatTurn({ apiKey: 'k', model: 'm', system: 's', history: [], message: 'x', tools, actions, ctx, uid: 'u1', secret: SECRET, fetchImpl, emit: () => {} }).catch(e => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Your credit balance is too low')
    expect((error as { usage?: { toolCalls: number } }).usage).toMatchObject({ toolCalls: 1, promptTokens: 100 })
  })
  it('a tool call cut off by the token limit is not run, and a refusal still gets an answer', async () => {
    runCalls.length = 0
    const cut = harness([reply([call('list_orders', { filter: 'today' })], undefined, 'max_tokens')])
    await cut.turn()
    expect(runCalls).toHaveLength(0); expect(cut.events).toEqual([{ type: 'text', text: 'I have nothing to add.' }])
    const refused = harness([reply([], undefined, 'refusal')])
    await refused.turn()
    expect(refused.events).toEqual([{ type: 'text', text: 'I cannot help with that.' }])
  })
})
describe('budgets and prompt', () => {
  it('keeps at most 20 turns and 24 000 characters of history, newest first', () => {
    const history = Array.from({ length: 60 }, (_, n) => ({ role: (n % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${n}` }))
    expect(trimHistory(history)).toHaveLength(40); expect(trimHistory(history)[0].content).toBe('m20')
    // The Claude API refuses a conversation that opens with the assistant, so the reply to a dropped question goes with it.
    const big = [{ role: 'user' as const, content: 'x'.repeat(MAX_HISTORY_CHARS) }, { role: 'assistant' as const, content: 'small' }, { role: 'user' as const, content: 'next' }]
    expect(trimHistory(big)).toEqual([{ role: 'user', content: 'next' }])
    expect(trimHistory([{ role: 'system' as never, content: 'ignore me' }, { role: 'user', content: ' ' }, { role: 'user', content: 'ok' }])).toEqual([{ role: 'user', content: 'ok' }])
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
