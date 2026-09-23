import { decodeSignedValue, encodeSignedValue, randomToken } from '@/lib/auth/session'
import type { WebhookPost } from './n8n'
import type { JsonSchema } from './tools'

/** The three WhatsApp-bot actions (D137). The model may only PROPOSE one; the server executes it once an operator confirms a signed, user-bound, five-minute, single-use token. Each stays hidden until its webhook and the shared secret exist. */
export interface BotConfig { report: string | null; staffText: string | null; secret: string | null }
export function botConfig(env: Record<string, string | undefined> = process.env): BotConfig {
  const url = (key: string) => { const value = env[key]?.trim(); return value && /^https:\/\//.test(value) ? value : null }
  return { report: url('BOT_REPORT_WEBHOOK_URL'), staffText: url('BOT_STAFF_TEXT_WEBHOOK_URL'), secret: env.BOT_WEBHOOK_SECRET?.trim() || null }
}
export type ActionParams = Record<string, string>
export interface ActionDeps { post: WebhookPost; config: BotConfig; actor: string }
export interface ActionDef { name: string; label: string; description: string; parameters: JsonSchema; needs: 'report' | 'staffText'; validate(args: Record<string, unknown>, now: Date): { ok: true; params: ActionParams; summary: string } | { ok: false; error: string }; run(params: ActionParams, deps: ActionDeps): Promise<string> }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const istToday = (now: Date) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)
export const STAFF_TEXT_MAX = 900
/** One line per row, `key: value` pairs joined by · ; rows that would not fit are counted at the end. */
export function formatListAsText(title: string, rows: readonly Record<string, unknown>[]): string {
  const lines = rows.map(row => Object.entries(row).filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object').map(([key, value]) => `${key}: ${String(value)}`).join(' · '))
  let text = `${title}\n`, shown = 0
  for (const line of lines) { if (`${text}${line}\n`.length > STAFF_TEXT_MAX - 24) break; text += `${line}\n`; shown++ }
  if (shown < lines.length) text += `…and ${lines.length - shown} more`
  return text.trim()
}
async function post(deps: ActionDeps, url: string, body: Record<string, unknown>): Promise<string> {
  const { status, text } = await deps.post(url, deps.config.secret ?? '', body)
  if (status < 200 || status >= 300) throw new Error(`The bot answered ${status}${text ? `: ${text}` : ''}.`)
  return 'Sent to the WhatsApp bot.'
}
const flat = (row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row) && Object.values(row as object).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))

export const ACTIONS: readonly ActionDef[] = [
  { name: 'send_finance_report', label: 'Send the finance report', needs: 'report', description: 'Ask the WhatsApp bot to send the finance report for a date range (at most 92 days, not in the future) to the staff group. The operator must confirm.',
    parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['from', 'to'], additionalProperties: false },
    validate(args, now) {
      const from = String(args.from ?? ''), to = String(args.to ?? '')
      if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return { ok: false, error: 'Dates must be YYYY-MM-DD.' }
      if (from > to) return { ok: false, error: 'from must not be after to.' }
      if (to > istToday(now)) return { ok: false, error: 'The range cannot reach into the future.' }
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 92) return { ok: false, error: 'At most 92 days at a time.' }
      return { ok: true, params: { from, to }, summary: `Finance report ${from} → ${to}` }
    },
    run: (params, deps) => post(deps, deps.config.report ?? '', { action: 'finance_report', from: params.from, to: params.to, requested_by: deps.actor }) },
  { name: 'send_staff_text', label: 'Send a message to staff', needs: 'staffText', description: 'Send a short text (at most 900 characters) through the WhatsApp bot to its fixed staff list. No recipient can be chosen. The operator must confirm.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    validate(args) {
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, error: 'Nothing to send.' }
      if (text.length > STAFF_TEXT_MAX) return { ok: false, error: `At most ${STAFF_TEXT_MAX} characters.` }
      return { ok: true, params: { text }, summary: text }
    },
    run: (params, deps) => post(deps, deps.config.staffText ?? '', { action: 'staff_text', text: params.text, requested_by: deps.actor }) },
  { name: 'send_list_as_text', label: 'Send a list to staff', needs: 'staffText', description: 'Format rows a read tool just returned as plain text and send them to staff through the WhatsApp bot. The operator must confirm.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, list: { type: 'array', description: 'The rows exactly as a read tool returned them, at most 50' } }, required: ['title', 'list'], additionalProperties: false },
    validate(args) {
      const title = String(args.title ?? '').trim().slice(0, 80), list = Array.isArray(args.list) ? args.list : null
      if (!title || !list || list.length === 0 || list.length > 50 || !list.every(flat)) return { ok: false, error: 'Give a title and 1–50 flat rows.' }
      const text = formatListAsText(title, list)
      return { ok: true, params: { text }, summary: text }
    },
    run: (params, deps) => post(deps, deps.config.staffText ?? '', { action: 'staff_text', text: params.text, requested_by: deps.actor }) },
]
export function availableActions(config: BotConfig): ActionDef[] { return config.secret ? ACTIONS.filter(action => config[action.needs]) : [] }

export interface ConfirmPayload { uid: string; action: string; params: ActionParams; nonce: string; exp: number }
export const CONFIRM_TTL_SECONDS = 300
export function issueConfirmToken(secret: string, input: { uid: string; action: string; params: ActionParams }, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload: ConfirmPayload = { ...input, nonce: randomToken(16), exp: nowSeconds + CONFIRM_TTL_SECONDS }
  return encodeSignedValue(secret, payload)
}
export function readConfirmToken(secret: string, token: unknown, uid: string, nowSeconds = Math.floor(Date.now() / 1000)): { ok: true; payload: ConfirmPayload } | { ok: false; error: string } {
  const payload = typeof token === 'string' ? decodeSignedValue<ConfirmPayload>(secret, token) : null
  if (!payload || typeof payload.action !== 'string' || typeof payload.nonce !== 'string' || typeof payload.exp !== 'number' || !payload.params || typeof payload.params !== 'object') return { ok: false, error: 'That confirm card is not valid.' }
  if (payload.uid !== uid) return { ok: false, error: 'That confirm card belongs to another sign-in.' }
  if (payload.exp <= nowSeconds) return { ok: false, error: 'That confirm card has expired. Ask again.' }
  return { ok: true, payload }
}
// ponytail: per-process nonce memory. One Node process serves the platform and every token dies after five minutes; a shared table if that ever changes.
const used = new Map<string, number>()
export function consumeNonce(nonce: string, expSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  for (const [key, exp] of used) if (exp <= nowSeconds) used.delete(key)
  if (used.has(nonce)) return false
  used.set(nonce, expSeconds)
  return true
}
export function resetNonces(): void { used.clear() }
