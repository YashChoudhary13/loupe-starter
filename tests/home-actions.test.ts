import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIONS, availableActions, botConfig, consumeNonce, formatListAsText, issueConfirmToken, readConfirmToken, resetNonces, STAFF_TEXT_MAX } from '@/lib/home/actions'

const SECRET = 'b'.repeat(64)
const now = new Date('2026-09-23T10:00:00Z')
const action = (name: string) => { const found = ACTIONS.find(item => item.name === name); if (!found) throw new Error(name); return found }
const connected = { report: 'https://n8n.example/webhook/report', staffText: 'https://n8n.example/webhook/staff', secret: 's3cret' }

describe('availability', () => {
  it('reads the three env keys and hides every action until its webhook and the secret exist', () => {
    expect(botConfig({})).toEqual({ report: null, staffText: null, secret: null })
    expect(botConfig({ BOT_REPORT_WEBHOOK_URL: 'http://insecure', BOT_STAFF_TEXT_WEBHOOK_URL: ' https://n8n.example/s ', BOT_WEBHOOK_SECRET: 'x' })).toEqual({ report: null, staffText: 'https://n8n.example/s', secret: 'x' })
    expect(availableActions({ report: 'https://r', staffText: 'https://s', secret: null })).toEqual([])
    expect(availableActions({ report: 'https://r', staffText: null, secret: 'x' }).map(item => item.name)).toEqual(['send_finance_report'])
    expect(availableActions(connected).map(item => item.name)).toEqual(['send_finance_report', 'send_staff_text', 'send_list_as_text'])
  })
})
describe('validation', () => {
  it('finance report: ISO dates, from ≤ to, not in the future (IST), at most 92 days', () => {
    const validate = (args: Record<string, unknown>) => action('send_finance_report').validate(args, now)
    expect(validate({ from: '2026-09-01', to: '2026-09-23' })).toEqual({ ok: true, params: { from: '2026-09-01', to: '2026-09-23' }, summary: 'Finance report 2026-09-01 → 2026-09-23' })
    expect(validate({ from: '2026-09-24', to: '2026-09-25' })).toMatchObject({ ok: false, error: expect.stringMatching(/future/) })
    expect(validate({ from: '2026-09-10', to: '2026-09-01' })).toMatchObject({ ok: false })
    expect(validate({ from: '2026-06-01', to: '2026-09-23' })).toMatchObject({ ok: false, error: expect.stringMatching(/92/) })
    expect(validate({ from: '1 Sep', to: '2026-09-23' })).toMatchObject({ ok: false })
  })
  it('staff text: 1–900 characters, trimmed', () => {
    const validate = (args: Record<string, unknown>) => action('send_staff_text').validate(args, now)
    expect(validate({ text: '  Pack Qimati5713 first  ' })).toEqual({ ok: true, params: { text: 'Pack Qimati5713 first' }, summary: 'Pack Qimati5713 first' })
    expect(validate({ text: '' })).toMatchObject({ ok: false }); expect(validate({ text: 'x'.repeat(STAFF_TEXT_MAX + 1) })).toMatchObject({ ok: false })
  })
  it('list as text: a title and 1–50 flat rows, formatted within the text limit', () => {
    const validate = (args: Record<string, unknown>) => action('send_list_as_text').validate(args, now)
    expect(validate({ title: 'Low stock', list: [{ sku: 'RS004', quantity: 0 }, { sku: 'NK970', quantity: 2 }] })).toEqual({ ok: true, params: { text: 'Low stock\nsku: RS004 · quantity: 0\nsku: NK970 · quantity: 2' }, summary: 'Low stock\nsku: RS004 · quantity: 0\nsku: NK970 · quantity: 2' })
    expect(validate({ title: 'x', list: [] })).toMatchObject({ ok: false }); expect(validate({ title: 'x', list: [{ nested: { a: 1 } }] })).toMatchObject({ ok: false })
    expect(validate({ title: 'x', list: Array.from({ length: 51 }, () => ({ a: 1 })) })).toMatchObject({ ok: false })
    const long = formatListAsText('Orders', Array.from({ length: 50 }, (_, n) => ({ order: `Qimati${5000 + n}`, total: '1,234.00 INR', items: 12 })))
    expect(long.length).toBeLessThanOrEqual(STAFF_TEXT_MAX); expect(long).toMatch(/…and \d+ more$/)
  })
})
describe('confirm tokens', () => {
  beforeEach(() => resetNonces())
  it('is bound to the user, expires after five minutes, and cannot be tampered with', () => {
    const token = issueConfirmToken(SECRET, { uid: 'u1', action: 'send_staff_text', params: { text: 'hi' } }, 1_000)
    expect(readConfirmToken(SECRET, token, 'u1', 1_100)).toMatchObject({ ok: true, payload: { uid: 'u1', action: 'send_staff_text', params: { text: 'hi' }, exp: 1_300 } })
    expect(readConfirmToken(SECRET, token, 'u2', 1_100)).toMatchObject({ ok: false, error: expect.stringMatching(/another sign-in/) })
    expect(readConfirmToken(SECRET, token, 'u1', 1_300)).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) })
    expect(readConfirmToken(SECRET, `${token.slice(0, -2)}xx`, 'u1', 1_100)).toMatchObject({ ok: false }); expect(readConfirmToken(SECRET, 7, 'u1', 1_100)).toMatchObject({ ok: false })
  })
  it('a nonce can be spent once, and forgotten once expired', () => {
    expect(consumeNonce('n1', 2_000, 1_000)).toBe(true); expect(consumeNonce('n1', 2_000, 1_001)).toBe(false)
    expect(consumeNonce('n2', 1_500, 1_000)).toBe(true); expect(consumeNonce('n2', 1_500, 1_600)).toBe(true)
  })
})
describe('execution', () => {
  const posts: { url: string; secret: string; body: Record<string, unknown> }[] = []
  const post = async (url: string, secret: string, body: Record<string, unknown>) => { posts.push({ url, secret, body }); return { status: url.endsWith('/staff') ? 200 : 500, text: url.endsWith('/staff') ? '' : 'boom' } }
  beforeEach(() => { posts.length = 0 })
  it('posts to the configured webhook with the shared secret and the actor, and reports the bot\'s refusal', async () => {
    expect(await action('send_staff_text').run({ text: 'hi' }, { post, config: connected, actor: 'owner@example.test' })).toBe('Sent to the WhatsApp bot.')
    expect(posts[0]).toEqual({ url: connected.staffText, secret: 's3cret', body: { action: 'staff_text', text: 'hi', requested_by: 'owner@example.test' } })
    await expect(action('send_finance_report').run({ from: '2026-09-01', to: '2026-09-23' }, { post, config: connected, actor: 'owner@example.test' })).rejects.toThrow(/500: boom/)
    expect(posts[1].body).toEqual({ action: 'finance_report', from: '2026-09-01', to: '2026-09-23', requested_by: 'owner@example.test' })
  })
})
