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
