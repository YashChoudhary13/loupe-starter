# Qimati Platform — Implementation Plan, part 9 of 10 (the Home screen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here. Task 13 consumes parts 3–7.

---

### Task 13: The Home screen — lights, tiles, chat panel, confirm card

**Files:**
- Create: `src/components/home/HealthLight.tsx`, `src/components/home/NumberTile.tsx`, `src/components/home/ChatPanel.tsx`, `src/components/home/HomeScreen.tsx`, `src/app/(shell)/home/page.tsx`
- Test: `tests/home-screen-render.test.ts`

**Interfaces:**
- Consumes: `ProbeLight` (Task 7), `HomeSnapshot` (Tasks 8/10), `ChatEvent`, `ChatMessage`, `ConfirmCard` type (Task 11), the two routes (Task 12).
- Produces: `HealthLight({ light })`, `NumberTile({ label, value, capped?, href? })`, `ChatPanel({ actionsConnected })`, `ConfirmCard({ card, outcome?, onConfirm })`, `HomeScreen(snapshot)`, the `/home` page.

- [ ] **Step 1: Write the failing test**

```ts
// tests/home-screen-render.test.ts
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPanel, ConfirmCard } from '@/components/home/ChatPanel'
import { HomeScreen } from '@/components/home/HomeScreen'
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
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/home-screen-render.test.ts`
Expected: FAIL — the components do not exist.

- [ ] **Step 3: The lights and the tiles**

```tsx
// src/components/home/HealthLight.tsx
import type { ProbeLight } from '@/lib/home/probes'

const TONE = { green: 'bg-green', amber: 'bg-amber', red: 'bg-[#b3261e]' } as const
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** One health light: a dot, the label, and either "ok · 312 ms" or "red since 23 Sept, 03:12 am · HTTP 502". */
export function HealthLight({ light }: { light: ProbeLight }) {
  return (
    <li className="flex items-center gap-3 rounded-panel bg-surface px-4 py-3">
      <span aria-hidden className={`size-3 shrink-0 rounded-full ${TONE[light.status]}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{light.label}</div>
        <div className="truncate text-[11.5px] text-muted-foreground">{light.status === 'green' ? `ok · ${light.ms} ms` : `${light.status} since ${when(light.since)} · ${light.detail}`}</div>
      </div>
      <span className="sr-only">{light.status}</span>
    </li>
  )
}
```

```tsx
// src/components/home/NumberTile.tsx
/** One headline number. `null` means the check failed; `capped` means "at least this many". A plain anchor, because the target may live on another face (the proxy redirects). */
export function NumberTile({ label, value, capped = false, href }: { label: string; value: number | null; capped?: boolean; href?: string }) {
  const body = (
    <>
      <div className="text-[26px] font-medium tracking-[-0.025em] tabular-nums">{value === null ? '—' : `${value}${capped ? '+' : ''}`}</div>
      <div className="mt-1 text-[11.5px] text-muted-foreground">{label}</div>
    </>
  )
  const className = 'block rounded-panel bg-surface px-4 py-3 focus-visible:outline-2'
  return href ? <a href={href} className={`${className} hover:bg-chip`}>{body}</a> : <div className={className}>{body}</div>
}
```

- [ ] **Step 4: The chat panel and the confirm card**

```tsx
// src/components/home/ChatPanel.tsx
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
```

- [ ] **Step 5: The screen and the page**

```tsx
// src/components/home/HomeScreen.tsx
import type { HomeSnapshot } from '@/lib/home/server'
import { ChatPanel } from './ChatPanel'
import { HealthLight } from './HealthLight'
import { NumberTile } from './NumberTile'

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

export function HomeScreen({ lights, numbers, actionsConnected }: HomeSnapshot) {
  const worst = lights.some(light => light.status === 'red') ? 'red' : lights.some(light => light.status === 'amber') ? 'amber' : 'green'
  return (
    <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-medium tracking-[-0.025em]">Qimati</h1>
          <p className="mt-1 text-[13px] text-ink-soft">{worst === 'green' ? 'Everything is answering.' : worst === 'amber' ? 'Something is slow or partly down.' : 'Something is down.'} Checked {clock(lights[0]?.checkedAt ?? numbers.computedAt)} IST.</p>
        </div>
        <span className="rounded-pill bg-chip px-3 py-1 text-[11.5px] text-ink-soft">Numbers as of {clock(numbers.computedAt)}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <NumberTile label="Orders today" value={numbers.ordersToday} />
        <NumberTile label="Paid, unfulfilled" value={numbers.paidUnfulfilled} />
        <NumberTile label="Awaiting QC" value={numbers.awaitingQc} capped={numbers.awaitingQcCapped} href="/qc" />
        <NumberTile label="Awaiting tracking" value={numbers.awaitingTracking} href="/dispatch" />
        <NumberTile label="Open shortages" value={numbers.openShortages} href="/qc/shortages" />
      </div>
      {numbers.problems.length > 0 && <p role="alert" className="mt-3 text-[12px] text-amber">{numbers.problems.join(' · ')}</p>}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <h2 className="mb-3 text-[15px] font-medium">Services</h2>
          {lights.length === 0 ? <p className="text-[13px] text-ink-soft">No probes configured.</p> : <ul className="grid gap-2">{lights.map(light => <HealthLight key={light.key} light={light} />)}</ul>}
        </div>
        <div><h2 className="mb-3 text-[15px] font-medium">Ask</h2><ChatPanel actionsConnected={actionsConnected} /></div>
      </div>
    </section>
  )
}
```

```tsx
// src/app/(shell)/home/page.tsx
import { HomeScreen } from '@/components/home/HomeScreen'
import { requireOperator } from '@/lib/auth/authorize'
import { homeSnapshot } from '@/lib/home/server'

export const dynamic = 'force-dynamic'

/** Health lights, five numbers and the assistant. Lights are at most 30 s old and numbers 60 s (in-process caches, D137); every render is authenticated. */
export default async function HomePage() {
  await requireOperator()
  return <HomeScreen {...await homeSnapshot()} />
}
```

- [ ] **Step 6: Run the test, typecheck, lint**

Run: `npx vitest run tests/home-screen-render.test.ts && npm run typecheck && npx eslint src/components/home "src/app/(shell)/home/page.tsx" tests/home-screen-render.test.ts`
Expected: PASS; clean. If the since-time regex fails only because Node's `en-IN` formatting differs ("Sep" vs "Sept", "am" vs "AM"), loosen the regex to `/red since 23 Sep.*3:12.* · 401/i` and say so in the report — the requirement is the "since" time in IST, not a locale spelling.

- [ ] **Step 7: Commit**

```bash
git add src/components/home/HealthLight.tsx src/components/home/NumberTile.tsx src/components/home/ChatPanel.tsx src/components/home/HomeScreen.tsx "src/app/(shell)/home/page.tsx" tests/home-screen-render.test.ts
git commit -m "feat(home): /home — health lights with since times, five number tiles, a chat panel with confirm cards"
```
