import Anthropic from '@anthropic-ai/sdk'

import { issueConfirmToken, type ActionDef, type ActionParams } from './actions'
import type { HomeNumbers } from './numbers'
import type { ProbeLight } from './probes'
import { runTool, toolSpecs, type ToolContext, type ToolDef } from './tools'

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ConfirmCard { action: string; label: string; summary: string; params: ActionParams; token: string }
export type ChatEvent = { type: 'status'; text: string } | { type: 'text'; text: string } | { type: 'confirm'; card: ConfirmCard } | { type: 'error'; text: string } | { type: 'done'; usage: TurnUsage }
export interface TurnUsage { model: string; promptTokens: number | null; completionTokens: number | null; cost: number | null; toolCalls: number }
export const MAX_TURNS = 20, MAX_HISTORY_CHARS = 24_000, MAX_TOOL_CALLS = 6, MAX_OUTPUT_TOKENS = 16_000, MIN_CALL_TOKENS = 2_000
export const DEFAULT_MODEL = 'claude-haiku-5-5'
/** Owner's choice, 2026-10-13: the model thinks as hard as it can before it answers. Thinking is paid as output, which is why the turn's token budget is 16 000 and no call gets fewer than 2 000. A model older than the 5.5 line (Haiku 4.5) refuses this setting. */
export const EFFORT = 'max'
/** List prices in USD per million tokens (input, output). The Claude API reports tokens, not money, so the cost line of `home.chat_turn` is worked out here; a model missing from this table logs a null cost. */
const PRICES: Record<string, readonly [number, number]> = { 'claude-haiku-4-5': [1, 5], 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] }

/** The tab's history, capped at 20 turns and roughly 6 000 tokens (24 000 characters), oldest dropped first. The Claude API refuses an empty message and a conversation that opens with the assistant, so neither survives here. */
export function trimHistory(history: readonly ChatMessage[]): ChatMessage[] {
  let kept = history.filter(item => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim()).slice(-MAX_TURNS * 2)
  while (kept.length && (kept[0].role === 'assistant' || kept.reduce((sum, item) => sum + item.content.length, 0) > MAX_HISTORY_CHARS)) kept = kept.slice(1)
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

export interface TurnInput { apiKey: string; workspaceId?: string; model: string; system: string; history: readonly ChatMessage[]; message: string; tools: readonly ToolDef[]; actions: readonly ActionDef[]; ctx: ToolContext; uid: string; secret: string; fetchImpl?: typeof fetch; now?: () => Date; emit(event: ChatEvent): void }
const asObject = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** One user message → at most 6 tool calls → one answer, on the Claude API at maximum effort (D149). Read tools run here; an action only becomes a confirm card. Model calls are not streamed; progress is. Every throw below carries the usage accumulated so far as `.usage`, so a caller that logs a failed turn still gets its cost line. */
export async function runChatTurn(input: TurnInput): Promise<TurnUsage> {
  const now = input.now ?? (() => new Date())
  // A key that is not tied to one workspace must name its workspace on every call; a single-workspace key needs no header.
  const client = new Anthropic({ apiKey: input.apiKey, fetch: input.fetchImpl, timeout: 60_000, maxRetries: 1, defaultHeaders: input.workspaceId ? { 'anthropic-workspace-id': input.workspaceId } : undefined })
  const messages: Anthropic.MessageParam[] = [...trimHistory(input.history), { role: 'user', content: input.message.slice(0, 8_000) }]
  const specs = toolSpecs([...input.tools, ...input.actions])
  const usage: TurnUsage = { model: input.model, promptTokens: null, completionTokens: null, cost: null, toolCalls: 0 }
  for (let round = 0; round <= MAX_TOOL_CALLS; round++) {
    // The 16 000-token budget is for the whole turn, not per call: track what's left and force a final answer once it runs low, same as running out of tool calls.
    const remaining = MAX_OUTPUT_TOKENS - (usage.completionTokens ?? 0), exhausted = usage.toolCalls >= MAX_TOOL_CALLS || remaining < MIN_CALL_TOKENS
    let reply: Anthropic.Message
    try { reply = await client.messages.create({ model: input.model, system: input.system, messages, ...(specs.length ? { tools: specs, tool_choice: { type: exhausted ? 'none' : 'auto' } } : {}), max_tokens: Math.max(MIN_CALL_TOKENS, remaining), output_config: { effort: EFFORT } }) }
    catch (error) {
      // The API's own sentence ("Your credit balance is too low…") reads better to the operator than the SDK's status code and JSON.
      const said = error instanceof Anthropic.APIError ? (error.error as { error?: { message?: string } } | undefined)?.error?.message : undefined
      throw Object.assign(new Error(said ?? (error instanceof Error ? error.message : 'The model did not answer.')), { usage })
    }
    usage.promptTokens = (usage.promptTokens ?? 0) + reply.usage.input_tokens; usage.completionTokens = (usage.completionTokens ?? 0) + reply.usage.output_tokens; usage.model = reply.model
    const price = Object.entries(PRICES).find(([id]) => usage.model.startsWith(id))?.[1]
    usage.cost = price ? Math.round(usage.promptTokens * price[0] + usage.completionTokens * price[1]) / 1_000_000 : null
    const text = reply.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map(block => block.text).join('').trim()
    const calls = reply.stop_reason === 'tool_use' ? reply.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use') : []
    if (!calls.length || exhausted) { input.emit({ type: 'text', text: text || (reply.stop_reason === 'refusal' ? 'I cannot help with that.' : 'I have nothing to add.') }); return usage }
    messages.push({ role: 'assistant', content: reply.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const item of calls) {
      const args = asObject(item.input), action = input.actions.find(candidate => candidate.name === item.name)
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
        input.emit({ type: 'status', text: `Checking ${item.name.replaceAll('_', ' ')}…` })
        result = await runTool(input.tools, item.name, args, input.ctx)
      }
      results.push({ type: 'tool_result', tool_use_id: item.id, content: result })
    }
    // Every result of one assistant turn goes back in a single user message.
    messages.push({ role: 'user', content: results })
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
