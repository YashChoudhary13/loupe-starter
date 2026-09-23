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

/** One user message → at most 6 tool calls → one answer. Read tools run here; an action only becomes a confirm card. Model calls are not streamed; progress is. Every throw below carries the usage accumulated so far as `.usage`, so a caller that logs a failed turn still gets its cost line. */
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
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `The model answered ${response.status}.`), { usage })
    add(body.usage); if (body.model) usage.model = body.model
    const choice = body.choices?.[0]
    if (choice?.error) throw Object.assign(new Error(choice.error.message ?? 'The model returned an error.'), { usage })
    if (!choice?.message) throw Object.assign(new Error(body.error?.message ?? 'The model returned no answer.'), { usage })
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
