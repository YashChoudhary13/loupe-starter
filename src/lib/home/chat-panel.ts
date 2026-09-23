import type { ChatMessage } from './chat'

/** Applies a bot-action outcome to the one entry whose card carries this token; every other entry is untouched. Matching by token, not array position, survives a status entry being spliced out from under a stale index. */
export function withOutcome<T extends { role: string; card?: { token: string }; outcome?: unknown }>(entries: T[], token: string, outcome: { ok: boolean; text: string }): T[] {
  return entries.map(entry => (entry.role === 'card' && entry.card?.token === token ? ({ ...entry, outcome } as T) : entry))
}

/** Splits a growing NDJSON buffer on newlines. Everything after the last `\n` is an incomplete line and comes back as `rest`, to prepend to the next chunk. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

const MAX_CLIENT_MESSAGES = 40, MAX_CLIENT_CHARS = 24_000

/** Shrinks the history sent with each turn so the request body stays under the chat route's cap: the newest 40 messages, then the oldest dropped while the total content length exceeds 24 000 characters. */
export function trimClientHistory(history: ChatMessage[]): ChatMessage[] {
  let kept = history.slice(-MAX_CLIENT_MESSAGES)
  while (kept.length > 0 && kept.reduce((sum, item) => sum + item.content.length, 0) > MAX_CLIENT_CHARS) kept = kept.slice(1)
  return kept
}
