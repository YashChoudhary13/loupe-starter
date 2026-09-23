import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPanel, ConfirmCard } from '@/components/home/ChatPanel'
import { HomeScreen } from '@/components/home/HomeScreen'
import { splitLines, trimClientHistory, withOutcome } from '@/lib/home/chat-panel'
import type { ChatMessage } from '@/lib/home/chat'
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
  it('a pending confirm card disables its Confirm button', () => {
    const card = { action: 'send_staff_text', label: 'Send a message to staff', summary: 'Pack faster', params: { text: 'Pack faster' }, token: 't' }
    const html = render(createElement(ConfirmCard, { card, pending: true, onConfirm: () => {} }))
    expect(html).toMatch(/<button[^>]*\sdisabled(="")?[\s>][^>]*>Confirm<\/button>/)
  })
  it('the header says no probes configured, not that everything is answering, when there are none', () => {
    const html = render(createElement(HomeScreen, { lights: [], numbers, actionsConnected: true }))
    expect(html).toContain('No probes configured.')
    expect(html).not.toContain('Everything is answering.')
  })
})

describe('chat-panel helpers', () => {
  it('withOutcome updates only the entry whose card matches the token', () => {
    const cardEntry = (token: string) => ({ id: Number(token), role: 'card' as const, content: 'x', card: { action: 'a', label: 'A', summary: 'x', params: {}, token } })
    const entries = [cardEntry('tok-1'), cardEntry('tok-2'), { id: 3, role: 'assistant' as const, content: 'hi' }]
    const outcome = { ok: true, text: 'Sent.' }
    const updated = withOutcome(entries, 'tok-2', outcome)
    expect((updated[0] as { outcome?: unknown }).outcome).toBeUndefined()
    expect((updated[1] as { outcome?: unknown }).outcome).toEqual(outcome)
    expect(updated[2]).toBe(entries[2])
  })
  it('splitLines separates complete lines from a trailing partial one', () => {
    expect(splitLines('a\nb\npartial')).toEqual({ lines: ['a', 'b'], rest: 'partial' })
    expect(splitLines('a\n')).toEqual({ lines: ['a'], rest: '' })
  })
  it('trimClientHistory keeps the newest 40 messages, then drops the oldest past 24 000 characters', () => {
    const many: ChatMessage[] = Array.from({ length: 45 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }))
    const byCount = trimClientHistory(many)
    expect(byCount).toHaveLength(40)
    expect(byCount[0].content).toBe('m5')

    const big: ChatMessage[] = Array.from({ length: 11 }, () => ({ role: 'user', content: 'x'.repeat(3_000) }))
    const byChars = trimClientHistory(big)
    expect(byChars.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(24_000)
    expect(byChars).toHaveLength(8)
  })
})
