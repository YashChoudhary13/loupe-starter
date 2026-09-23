'use client'

import { useEffect, useRef, useState } from 'react'
import { splitLines, trimClientHistory, withOutcome } from '@/lib/home/chat-panel'
import type { ChatEvent, ChatMessage, ConfirmCard as Card } from '@/lib/home/chat'

type EntryData = ChatMessage | { role: 'status'; content: string } | { role: 'problem'; content: string } | { role: 'card'; content: string; card: Card; outcome?: { ok: boolean; text: string } }
type Entry = EntryData & { id: number }
const pill = 'rounded-pill px-4 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40'
const isTurn = (entry: Entry): entry is Entry & ChatMessage => entry.role === 'user' || entry.role === 'assistant'

/** The conversation lives in this tab's React state and nowhere else (D137). Entries carry a stable `id` (not array position), because status lines are spliced out mid-turn and a confirm outcome must still find its own card afterwards. */
export function ChatPanel({ actionsConnected }: { actionsConnected: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(0)
  // Scrolls only this box, not every scrollable ancestor (scrollIntoView walks the whole page on a phone).
  useEffect(() => { if (entries.length && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [entries])
  const append = (entry: EntryData) => setEntries(current => [...current, { ...entry, id: ++nextId.current }])

  function handle(event: ChatEvent) {
    if (event.type === 'status') append({ role: 'status', content: event.text })
    else if (event.type === 'text') append({ role: 'assistant', content: event.text })
    else if (event.type === 'error') append({ role: 'problem', content: event.text })
    else if (event.type === 'confirm') append({ role: 'card', content: event.card.summary, card: event.card })
  }
  async function send() {
    const message = draft.trim()
    if (!message || busy) return
    const history = trimClientHistory(entries.filter(isTurn).map(({ role, content }): ChatMessage => ({ role, content })))
    setDraft(''); setBusy(true); append({ role: 'user', content: message })
    try {
      const response = await fetch('/api/home/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, messages: history }) })
      if (!response.ok || !response.body) { append({ role: 'problem', content: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'The assistant did not answer.' }); return }
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const split = splitLines(buffer); buffer = split.rest
        for (const line of split.lines) {
          if (!line.trim()) continue
          try { handle(JSON.parse(line) as ChatEvent) } catch { console.warn('malformed chat event line:', line) }
        }
        if (done) break
      }
    } catch { append({ role: 'problem', content: 'The connection dropped. Ask again.' }) }
    finally { setBusy(false); setEntries(current => current.filter(entry => entry.role !== 'status')) }
  }
  async function confirmCard(token: string) {
    const target = entries.find(entry => entry.role === 'card' && entry.card.token === token)
    if (!target || target.role !== 'card' || target.outcome) return
    setConfirming(token)
    let outcome: { ok: boolean; text: string }
    try {
      const response = await fetch('/api/home/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
      outcome = { ok: body.ok === true, text: body.text ?? body.error ?? 'No answer.' }
    } catch { outcome = { ok: false, text: 'The connection dropped.' } }
    finally { setConfirming(null) }
    setEntries(current => withOutcome(current, token, outcome))
  }

  return (
    <div className="flex h-[min(70vh,640px)] flex-col rounded-card bg-surface p-4">
      <div ref={listRef} className="loupe-scroll min-h-0 flex-1 overflow-auto">
        {entries.length === 0 && <p className="text-[13px] text-ink-soft">Ask about orders, stock, QC, dispatch or the bot. The assistant reads live numbers and never changes anything in Shopify.{actionsConnected ? '' : ' Bot actions are not connected yet.'}</p>}
        <ul role="log" aria-live="polite" className="grid gap-2">
          {entries.map(entry => (
            <li key={entry.id} role={entry.role === 'problem' ? 'alert' : undefined} className={entry.role === 'user' ? 'justify-self-end rounded-panel bg-ink px-4 py-2 text-[13px] text-white' : entry.role === 'status' ? 'text-[11.5px] text-muted-foreground' : entry.role === 'problem' ? 'rounded-panel bg-chip px-4 py-2 text-[13px] text-amber' : entry.role === 'card' ? '' : 'whitespace-pre-wrap rounded-panel bg-chip px-4 py-2 text-[13px]'}>
              {entry.role === 'card' ? <ConfirmCard card={entry.card} outcome={entry.outcome} pending={confirming === entry.card.token} onConfirm={() => void confirmCard(entry.card.token)} /> : entry.content}
            </li>
          ))}
        </ul>
      </div>
      <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void send() }}>
        <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} placeholder="How many orders are waiting for QC?" aria-label="Ask the assistant" className="min-w-0 flex-1 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink" />
        <button type="submit" disabled={busy || !draft.trim()} className={`${pill} bg-ink text-white`}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
    </div>
  )
}

/** A proposed bot action. Confirm once; the outcome replaces the button. `pending` disables the button while that confirm request is in flight. */
export function ConfirmCard({ card, outcome, pending = false, onConfirm }: { card: Card; outcome?: { ok: boolean; text: string }; pending?: boolean; onConfirm: () => void }) {
  return (
    <div className="rounded-panel border border-face-accent bg-surface p-3">
      <div className="text-[11px] uppercase tracking-[0.11em] text-muted-foreground">{card.label}</div>
      <p className="mt-1 whitespace-pre-wrap text-[13px]">{card.summary}</p>
      {outcome ? <p role="status" className={`mt-2 text-[12.5px] ${outcome.ok ? 'text-green' : 'text-amber'}`}>{outcome.text}</p> : (
        <div className="mt-2 flex items-center gap-2"><button type="button" disabled={pending} onClick={onConfirm} className={`${pill} bg-ink text-white`}>Confirm</button><span className="text-[11.5px] text-muted-foreground">Nothing is sent until you confirm.</span></div>
      )}
    </div>
  )
}
