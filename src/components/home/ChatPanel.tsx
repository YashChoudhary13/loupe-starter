'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, ConfirmCard as Card } from '@/lib/home/chat'

type Entry = ChatMessage | { role: 'status'; content: string } | { role: 'card'; content: string; card: Card; outcome?: { ok: boolean; text: string } }
const pill = 'rounded-pill px-4 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40'
const isTurn = (entry: Entry): entry is ChatMessage => entry.role === 'user' || entry.role === 'assistant'

/** The conversation lives in this tab's React state and nowhere else (D137). */
export function ChatPanel({ actionsConnected }: { actionsConnected: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [entries])
  const append = (entry: Entry) => setEntries(current => [...current, entry])

  function handle(event: ChatEvent) {
    if (event.type === 'status') append({ role: 'status', content: event.text })
    else if (event.type === 'text' || event.type === 'error') append({ role: 'assistant', content: event.text })
    else if (event.type === 'confirm') append({ role: 'card', content: event.card.summary, card: event.card })
  }
  async function send() {
    const message = draft.trim()
    if (!message || busy) return
    const history = entries.filter(isTurn)
    setDraft(''); setBusy(true); append({ role: 'user', content: message })
    try {
      const response = await fetch('/api/home/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, messages: history }) })
      if (!response.ok || !response.body) { append({ role: 'assistant', content: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'The assistant did not answer.' }); return }
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const parts = buffer.split('\n'); buffer = parts.pop() ?? ''
        for (const part of parts) if (part.trim()) handle(JSON.parse(part) as ChatEvent)
        if (done) break
      }
    } catch { append({ role: 'assistant', content: 'The connection dropped. Ask again.' }) }
    finally { setBusy(false); setEntries(current => current.filter(entry => entry.role !== 'status')) }
  }
  async function confirmCard(index: number) {
    const entry = entries[index]
    if (!entry || entry.role !== 'card' || entry.outcome) return
    let outcome: { ok: boolean; text: string }
    try {
      const response = await fetch('/api/home/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: entry.card.token }) })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
      outcome = { ok: body.ok === true, text: body.text ?? body.error ?? 'No answer.' }
    } catch { outcome = { ok: false, text: 'The connection dropped.' } }
    setEntries(current => current.map((item, n) => (n === index && item.role === 'card' ? { ...item, outcome } : item)))
  }

  return (
    <div className="flex h-[min(70vh,640px)] flex-col rounded-card bg-surface p-4">
      <div className="loupe-scroll min-h-0 flex-1 overflow-auto">
        {entries.length === 0 && <p className="text-[13px] text-ink-soft">Ask about orders, stock, QC, dispatch or the bot. The assistant reads live numbers and never changes anything in Shopify.{actionsConnected ? '' : ' Bot actions are not connected yet.'}</p>}
        <ul className="grid gap-2">
          {entries.map((entry, index) => (
            <li key={index} className={entry.role === 'user' ? 'justify-self-end rounded-panel bg-ink px-4 py-2 text-[13px] text-white' : entry.role === 'status' ? 'text-[11.5px] text-muted-foreground' : entry.role === 'card' ? '' : 'whitespace-pre-wrap rounded-panel bg-chip px-4 py-2 text-[13px]'}>
              {entry.role === 'card' ? <ConfirmCard card={entry.card} outcome={entry.outcome} onConfirm={() => void confirmCard(index)} /> : entry.content}
            </li>
          ))}
        </ul>
        <div ref={endRef} />
      </div>
      <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void send() }}>
        <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} placeholder="How many orders are waiting for QC?" aria-label="Ask the assistant" className="min-w-0 flex-1 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink" />
        <button type="submit" disabled={busy || !draft.trim()} className={`${pill} bg-ink text-white`}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
    </div>
  )
}

/** A proposed bot action. Confirm once; the outcome replaces the button. */
export function ConfirmCard({ card, outcome, onConfirm }: { card: Card; outcome?: { ok: boolean; text: string }; onConfirm: () => void }) {
  return (
    <div className="rounded-panel border border-face-accent bg-surface p-3">
      <div className="text-[11px] uppercase tracking-[0.11em] text-muted-foreground">{card.label}</div>
      <p className="mt-1 whitespace-pre-wrap text-[13px]">{card.summary}</p>
      {outcome ? <p className={`mt-2 text-[12.5px] ${outcome.ok ? 'text-green' : 'text-amber'}`}>{outcome.text}</p> : (
        <div className="mt-2 flex items-center gap-2"><button type="button" onClick={onConfirm} className={`${pill} bg-ink text-white`}>Confirm</button><span className="text-[11.5px] text-muted-foreground">Nothing is sent until you confirm.</span></div>
      )}
    </div>
  )
}
