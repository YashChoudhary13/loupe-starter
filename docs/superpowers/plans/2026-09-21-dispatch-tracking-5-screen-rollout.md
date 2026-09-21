# Dispatch Tracking — Implementation Plan, part 5 of 5 (row model, screen, docs, rollout)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal, architecture, tech stack, file index and Global Constraints:** see part 1 (`2026-09-21-dispatch-tracking-1-types-schema.md`). Every constraint there applies here. Tasks 1–7 must be complete first.

---

### Task 8: Row model (pure)

**Files:**
- Create: `src/lib/dispatch/rows.ts`
- Test: `tests/dispatch-rows.test.ts`

**Interfaces:**
- Consumes: `DispatchOrderSummary`, `ParcelRow` (Task 1).
- Produces: `DispatchRowModel`, `DispatchChild`, `buildRows(orders, qcPassed, open): DispatchRowModel[]`, `isStaged(row): boolean`, `duplicateTracking(rows): Map<string, string[]>` (tracking number → order names, only numbers used by more than one row).

- [ ] **Step 1: Write the failing test**

```ts
// tests/dispatch-rows.test.ts
import { describe, expect, it } from 'vitest'
import { buildRows, duplicateTracking, isStaged } from '@/lib/dispatch/rows'
import type { DispatchOrderSummary, ParcelOrderRow, ParcelRow } from '@/lib/dispatch/types'

const order = (n: number, addressKey = 'aaaa'): DispatchOrderSummary => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: `2026-09-2${n}T05:00:00Z`, customer: `Customer ${n}`, addressKey })
const item = (n: number, position: number, status: ParcelOrderRow['status'] = 'staged'): ParcelOrderRow => ({ id: `r${n}`, parcel_id: 'p', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position, status, fulfillment_id: status === 'fulfilled' ? 'f' : null, error: null, push_started_at: null, finished_at: null })
const parcel = (id: string, orders: ParcelOrderRow[], tracking: string | null = 'X1234567'): ParcelRow => ({ id, tracking_number: tracking, carrier: tracking ? 'DTDC' : null, carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders })

describe('dispatch rows', () => {
  it('nests added orders under their parcel and removes them from the main list', () => {
    const rows = buildRows([order(1), order(2, 'bbbb'), order(3)], { 'gid://shopify/Order/2': true }, [parcel('p1', [item(1, 0), item(2, 1)])])
    expect(rows.map(row => row.order.name)).toEqual(['Qimati3', 'Qimati1'])
    expect(rows[1].children).toEqual([{ orderId: 'gid://shopify/Order/2', orderName: 'Qimati2', listed: true, qcPassed: true, differentAddress: true, status: 'staged', error: null }])
    expect(isStaged(rows[1])).toBe(true); expect(isStaged(rows[0])).toBe(false)
  })
  it('promotes the next order when the first of a parcel is already fulfilled', () => {
    const rows = buildRows([order(2)], {}, [parcel('p1', [item(1, 0, 'fulfilled'), item(2, 1, 'failed')])])
    expect(rows).toHaveLength(1); expect(rows[0].order.name).toBe('Qimati2'); expect(rows[0].children).toEqual([])
  })
  it('keeps staged work visible when its order left the Shopify list', () => {
    const [row] = buildRows([], {}, [parcel('p1', [item(9, 0)])])
    expect(row).toMatchObject({ listed: false, order: { name: 'Qimati9', customer: '—' } })
  })
  it('does not call a parcel staged without a number', () => { expect(isStaged(buildRows([order(1)], {}, [parcel('p1', [item(1, 0)], null)])[0])).toBe(false) })
  it('reports a number used by two parcels, and only that', () => {
    const rows = buildRows([order(1), order(2), order(3)], {}, [parcel('p1', [item(1, 0)]), parcel('p2', [{ ...item(2, 0), parcel_id: 'p2' }]), parcel('p3', [{ ...item(3, 0), parcel_id: 'p3' }], 'X7654321')])
    expect([...duplicateTracking(rows)]).toEqual([['X1234567', ['Qimati2', 'Qimati1']]])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/dispatch-rows.test.ts`
Expected: FAIL — cannot resolve `@/lib/dispatch/rows`.

- [ ] **Step 3: Implement**

```ts
// src/lib/dispatch/rows.ts
import type { DispatchOrderSummary, ParcelOrderStatus, ParcelRow } from './types'

export interface DispatchChild { orderId: string; orderName: string; listed: boolean; qcPassed: boolean; differentAddress: boolean; status: ParcelOrderStatus; error: string | null }
export interface DispatchRowModel { order: DispatchOrderSummary; listed: boolean; qcPassed: boolean; parcel: ParcelRow | null; status: ParcelOrderStatus | null; error: string | null; children: DispatchChild[] }

/** One row per parcel (its first unfulfilled order) plus one per listed order not yet in a parcel; newest order first. */
export function buildRows(orders: readonly DispatchOrderSummary[], qcPassed: Readonly<Record<string, boolean>>, open: readonly ParcelRow[]): DispatchRowModel[] {
  const byId = new Map(orders.map(order => [order.id, order]))
  const placed = new Set<string>()
  const rows: DispatchRowModel[] = []
  for (const parcel of open) {
    const pending = parcel.orders.filter(item => item.status !== 'fulfilled').sort((a, b) => a.position - b.position)
    if (pending.length === 0) continue
    const [first, ...rest] = pending
    const order = byId.get(first.order_id) ?? { id: first.order_id, name: first.order_name, createdAt: parcel.staged_at, customer: '—', addressKey: '' }
    rows.push({
      order, listed: byId.has(first.order_id), qcPassed: !!qcPassed[first.order_id], parcel, status: first.status, error: first.error,
      children: rest.map(item => {
        const child = byId.get(item.order_id)
        return { orderId: item.order_id, orderName: item.order_name, listed: !!child, qcPassed: !!qcPassed[item.order_id], differentAddress: !!child && !!order.addressKey && child.addressKey !== order.addressKey, status: item.status, error: item.error }
      }),
    })
    for (const item of pending) placed.add(item.order_id)
  }
  for (const order of orders) if (!placed.has(order.id)) rows.push({ order, listed: true, qcPassed: !!qcPassed[order.id], parcel: null, status: null, error: null, children: [] })
  return rows.sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt))
}

/** Ready to push: the parcel has both a number and a carrier. */
export function isStaged(row: DispatchRowModel): boolean { return !!row.parcel?.tracking_number && !!row.parcel.carrier }

export function duplicateTracking(rows: readonly DispatchRowModel[]): Map<string, string[]> {
  const names = new Map<string, string[]>()
  for (const row of rows) { const number = row.parcel?.tracking_number; if (number) names.set(number, [...(names.get(number) ?? []), row.order.name]) }
  return new Map([...names].filter(([, list]) => list.length > 1))
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/dispatch-rows.test.ts && npm run typecheck`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dispatch/rows.ts tests/dispatch-rows.test.ts
git commit -m "feat(dispatch): row model — parcels with nested orders, unlisted staged work, duplicate numbers"
```


---

### Task 9: Screen, page and sidebar entry

**Files:**
- Create: `src/components/dispatch/DispatchScreen.tsx`
- Create: `src/app/(shell)/dispatch/page.tsx`
- Modify: `src/components/console/Sidebar.tsx:21-22` (types), `:34` (item), `:60-61` (active section)
- Test: `tests/dispatch-screen-render.test.ts`

**Interfaces:**
- Consumes: actions (Task 7), `buildRows`/`isStaged`/`duplicateTracking` (Task 8), `detectCarrier`/`normalizeTracking` (Task 1), `listDispatchOrders`/`dispatchShopifyError` (Task 3), `listParcels` (Task 6), `qcOrderStatuses` (`@/lib/qc/server`), `requireOperator`.
- Produces: `DispatchScreen(props: DispatchScreenProps)`, route `/dispatch`.

- [ ] **Step 1: Write the failing render test**

```ts
// tests/dispatch-screen-render.test.ts
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('@/app/(shell)/dispatch/actions', () => ({ stageTrackingAction: vi.fn(), groupOrderAction: vi.fn(), ungroupOrderAction: vi.fn(), discardParcelAction: vi.fn(), pushParcelAction: vi.fn() }))
import { DispatchScreen, type DispatchScreenProps } from '@/components/dispatch/DispatchScreen'

const order = (n: number) => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: `2026-09-2${n}T05:00:00Z`, customer: `Customer ${n}`, addressKey: 'aaaa' })
const item = (n: number, position: number, status = 'staged') => ({ id: `r${n}`, parcel_id: 'p1', order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position, status, fulfillment_id: status === 'fulfilled' ? 'f1' : null, error: null, push_started_at: null, finished_at: null })
const props = (changes: Partial<DispatchScreenProps> = {}): DispatchScreenProps => ({
  orders: [order(1), order(2), order(3)], qcPassed: { 'gid://shopify/Order/1': true }, truncated: false,
  open: [{ id: 'p1', tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-21T05:00:00Z', pushed_by: null, pushed_at: null, orders: [item(1, 0), item(2, 1)] as never }],
  recent: [{ id: 'p0', tracking_number: '884512209', carrier: 'Tirupati Courier', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-20T05:00:00Z', pushed_by: 'owner@example.test', pushed_at: '2026-09-20T09:00:00Z', orders: [item(7, 0, 'fulfilled')] as never }],
  ...changes,
})
const render = (p: DispatchScreenProps) => renderToString(createElement(DispatchScreen, p)).replace(/<!-- -->/g, '')

describe('Dispatch screen', () => {
  it('shows staged parcels with their added order, QC badges and the push count', () => {
    const html = render(props())
    expect(html).toContain('Qimati1'); expect(html).toContain('value="X1234567"')
    expect(html).toMatch(/same parcel[\s\S]*Qimati2|Qimati2[\s\S]*same parcel/)
    expect(html).toContain('aria-label="QC checked"'); expect(html).toContain('aria-label="QC not checked"')
    expect(html).toContain('Push 0 parcels'); expect(html).toContain('Select all staged (1)')
    expect(html).toContain('<option value="DTDC" selected="">DTDC</option>')
  })
  it('lists the last 30 days of pushes', () => { const html = render(props()); expect(html).toContain('Qimati7'); expect(html).toContain('Tirupati Courier 884512209'); expect(html).toContain('owner@example.test') })
  it('says when Shopify access is missing or the list was cut short', () => {
    expect(render(props({ orders: [], open: [], error: 'Loupe cannot read or fulfil orders yet.' }))).toContain('role="alert"')
    expect(render(props({ truncated: true }))).toContain('more than 300 open orders')
  })
  it('offers a way out for staged work whose order left the list', () => { expect(render(props({ orders: [] }))).toContain('no longer In progress') })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/dispatch-screen-render.test.ts`
Expected: FAIL — cannot resolve `@/components/dispatch/DispatchScreen`.

- [ ] **Step 3: Implement the screen**

```tsx
// src/components/dispatch/DispatchScreen.tsx
'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { discardParcelAction, groupOrderAction, pushParcelAction, stageTrackingAction, ungroupOrderAction } from '@/app/(shell)/dispatch/actions'
import { detectCarrier, normalizeTracking } from '@/lib/dispatch/carrier'
import { buildRows, duplicateTracking, isStaged, type DispatchRowModel } from '@/lib/dispatch/rows'
import { CARRIERS, type DispatchOrderSummary, type ParcelRow } from '@/lib/dispatch/types'
import type { PushResult } from '@/lib/dispatch/push'

export interface DispatchScreenProps { orders: DispatchOrderSummary[]; qcPassed: Record<string, boolean>; open: ParcelRow[]; recent: ParcelRow[]; truncated: boolean; error?: string }

const when = (value: string) => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const field = 'min-w-0 rounded-pill bg-chip px-4 py-2 text-[13px] focus:outline-2 focus:outline-ink disabled:opacity-40'
const pill = 'rounded-pill px-4 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40'

function QcBadge({ passed }: { passed: boolean }) {
  const label = passed ? 'QC checked' : 'QC not checked'
  return <span role="img" aria-label={label} title={label} className={`inline-grid h-5 w-5 shrink-0 place-items-center rounded-full ${passed ? 'bg-ink text-white' : 'border border-chip text-ink-soft'}`}>
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{passed ? <path d="M3 8.5l3 3 7-7" /> : <path d="M4 8h8" />}</svg>
  </span>
}

export function DispatchScreen({ orders, qcPassed, open, recent, truncated, error }: DispatchScreenProps) {
  const router = useRouter()
  const rows = useMemo(() => buildRows(orders, qcPassed, open), [orders, qcPassed, open])
  const duplicates = useMemo(() => duplicateTracking(rows), [rows])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [results, setResults] = useState<PushResult[]>([])
  const [busy, startTransition] = useTransition()

  const staged = rows.filter(isStaged)
  const chosen = staged.filter(row => selected.has(row.order.id))
  const chosenOrders = chosen.reduce((sum, row) => sum + 1 + row.children.length, 0)
  const note = (id: string, message: string) => setMessages(current => ({ ...current, [id]: message }))
  const act = (id: string, work: () => Promise<{ ok: boolean; message: string }>, after?: () => void) => startTransition(async () => {
    const state = await work()
    note(id, state.ok ? '' : state.message)
    if (state.ok) { after?.(); router.refresh() }
  })
  const save = (row: DispatchRowModel, tracking: string, carrier?: string) => act(row.order.id,
    () => stageTrackingAction({ orderId: row.order.id, orderName: row.order.name, tracking, carrier }),
    () => setDrafts(current => { const next = { ...current }; delete next[row.order.id]; return next }))
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const push = () => startTransition(async () => {
    setConfirming(false)
    const all: PushResult[] = []
    for (const row of chosen) {
      const outcome = await pushParcelAction(row.parcel!.id)
      all.push(...(outcome.results.length ? outcome.results : [{ orderId: row.order.id, orderName: row.order.name, status: 'failed' as const, message: outcome.message }]))
      setResults([...all])
    }
    setSelected(new Set()); router.refresh()
  })

  return <section className="h-full overflow-auto px-3 py-4 md:px-8 md:py-6">
    <h1 className="text-[26px] font-medium tracking-[-0.025em]">Dispatch</h1>
    <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Orders marked In progress in Shopify. Type or scan a tracking number to stage it, select the staged rows, then push: each order is fulfilled with its carrier and number, and the customer is notified.</p>
    {error && <p role="alert" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">{error}</p>}
    {truncated && <p role="status" className="mt-4 rounded-panel bg-white p-4 text-[13px] text-amber">There are more than 300 open orders, so this list may be incomplete. Archive old fulfilled orders in Shopify.</p>}

    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">In progress · {rows.length}</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${pill} bg-chip`} disabled={staged.length === 0} onClick={() => setSelected(new Set(staged.map(row => row.order.id)))}>Select all staged ({staged.length})</button>
          <button type="button" className={`${pill} bg-ink text-white`} disabled={chosen.length === 0 || busy} onClick={() => setConfirming(true)}>Push {chosen.length} parcel{chosen.length === 1 ? '' : 's'} · {chosenOrders} order{chosenOrders === 1 ? '' : 's'}</button>
        </div>
      </div>
      {rows.length === 0 && !error && <p className="py-8 text-[13px] text-ink-soft">Nothing is marked In progress in Shopify.</p>}
      <div className="grid gap-3">{rows.map((row, index) => {
        const id = row.order.id
        const locked = row.status === 'pushing' || busy
        const tracking = drafts[id] ?? row.parcel?.tracking_number ?? ''
        const carrier = row.parcel?.carrier ?? detectCarrier(normalizeTracking(tracking)) ?? ''
        const sharing = row.parcel?.tracking_number && duplicates.has(row.parcel.tracking_number) ? rows.filter(other => other.order.id !== id && other.parcel?.tracking_number === row.parcel!.tracking_number) : []
        const candidates = adding === id ? rows.filter(other => other.order.id !== id && other.listed && other.children.length === 0 && other.status !== 'pushing' && other.order.name.toLowerCase().includes(search.trim().toLowerCase()))
          .sort((a, b) => Number(b.order.addressKey === row.order.addressKey) - Number(a.order.addressKey === row.order.addressKey)).slice(0, 8) : []
        return <div key={id} className="rounded-panel border border-chip bg-white p-3 md:p-4">
          <div className="grid items-center gap-3 md:grid-cols-[auto_auto_minmax(0,1.2fr)_minmax(0,1fr)_170px_minmax(0,1.4fr)_auto]">
            <input type="checkbox" aria-label={`Select ${row.order.name}`} checked={selected.has(id)} disabled={!isStaged(row) || locked} onChange={() => toggle(id)} className="h-4 w-4" />
            <QcBadge passed={row.qcPassed} />
            <div className="flex items-center gap-2"><span className="text-[15px] font-medium">{row.order.name}</span>
              <button type="button" aria-label={`Add another order to the parcel of ${row.order.name}`} title="Add an order that travels in the same parcel" disabled={locked} onClick={() => { setAdding(adding === id ? null : id); setSearch('') }} className="inline-grid h-6 w-6 place-items-center rounded-full bg-chip text-[15px] leading-none focus-visible:outline-2">+</button></div>
            <span className="truncate text-[12px] text-ink-soft">{row.order.customer}</span>
            <select aria-label={`Carrier for ${row.order.name}`} value={carrier} disabled={locked} onChange={event => save(row, tracking, event.target.value)} className={field}>
              <option value="">{row.parcel?.carrier_source === 'manual' ? 'Detect automatically' : '— carrier —'}</option>
              {CARRIERS.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <input aria-label={`Tracking number for ${row.order.name}`} data-tracking-index={index} value={tracking} disabled={locked} maxLength={40} placeholder="Tracking number" autoComplete="off" spellCheck={false} className={field}
              onChange={event => setDrafts(current => ({ ...current, [id]: event.target.value }))}
              onBlur={() => { if (id in drafts && normalizeTracking(drafts[id]) !== (row.parcel?.tracking_number ?? '')) save(row, drafts[id]) }}
              onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); event.currentTarget.blur(); document.querySelector<HTMLInputElement>(`[data-tracking-index="${index + 1}"]`)?.focus() }} />
            <span className="rounded-pill bg-chip px-3 py-2 text-[12px]">{row.status === 'pushing' ? 'pushing…' : row.status === 'failed' ? 'failed' : isStaged(row) ? 'staged' : '—'}</span>
          </div>
          {row.children.map(child => <div key={child.orderId} className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-chip pl-3 text-[13px] md:ml-12">
            <QcBadge passed={child.qcPassed} /><span className="font-medium">{child.orderName}</span><span className="text-[12px] text-ink-soft">same parcel</span>
            {child.differentAddress && <span className="text-[12px] text-amber">different delivery address</span>}
            {!child.listed && <span className="text-[12px] text-amber">no longer In progress</span>}
            {child.error && <span className="text-[12px] text-amber">{child.error}</span>}
            <button type="button" aria-label={`Remove ${child.orderName} from this parcel`} disabled={locked || child.status === 'pushing'} onClick={() => act(id, () => ungroupOrderAction(child.orderId))} className="inline-grid h-6 w-6 place-items-center rounded-full bg-chip leading-none focus-visible:outline-2">×</button>
          </div>)}
          {adding === id && <div className="mt-3 rounded-panel bg-chip p-3 md:ml-12">
            <input aria-label="Find an order to add" value={search} onChange={event => setSearch(event.target.value)} placeholder="Order number, for example Qimati5899" className={`${field} w-full bg-white`} />
            <div className="mt-2 flex flex-wrap gap-2">{candidates.map(other => <button key={other.order.id} type="button" className={`${pill} bg-white`} onClick={() => act(id, () => groupOrderAction({ primaryOrderId: id, primaryOrderName: row.order.name, orderId: other.order.id, orderName: other.order.name }), () => setAdding(null))}>{other.order.name}{other.order.addressKey && other.order.addressKey === row.order.addressKey ? ' · same address' : ''}</button>)}
              {candidates.length === 0 && <span className="text-[12px] text-ink-soft">No other In-progress order matches. Mark it In progress in Shopify first.</span>}</div>
          </div>}
          {!row.listed && <p className="mt-2 text-[12px] text-amber">{row.order.name} is no longer In progress in Shopify. <button type="button" className="underline" disabled={locked} onClick={() => act(id, () => discardParcelAction(row.parcel!.id))}>Discard this staged number</button></p>}
          {sharing.map(other => <p key={other.order.id} className="mt-2 text-[12px] text-amber">Same number as {other.order.name}. <button type="button" className="underline" disabled={locked} onClick={() => act(id, () => groupOrderAction({ primaryOrderId: id, primaryOrderName: row.order.name, orderId: other.order.id, orderName: other.order.name }))}>Group them into one parcel</button></p>)}
          {row.error && <p className="mt-2 text-[12px] text-amber">{row.error}</p>}
          {messages[id] && <p role="alert" className="mt-2 text-[12px] text-amber">{messages[id]}</p>}
        </div>
      })}</div>
      {results.length > 0 && <div role="status" className="mt-5 rounded-panel bg-white p-4 text-[13px]"><h3 className="mb-2 font-medium">Last push</h3>
        {results.map(result => <p key={result.orderId} className={result.status === 'fulfilled' ? '' : 'text-amber'}>{result.status === 'fulfilled' ? '✓' : '!'} {result.orderName} — {result.message}</p>)}</div>}
    </div>

    <div className="mt-6 rounded-card bg-surface p-4 md:p-6">
      <h2 className="mb-4 text-[15px] font-medium">Pushed in the last 30 days · {recent.length}</h2>
      {recent.length === 0 && <p className="py-4 text-[13px] text-ink-soft">Nothing has been pushed yet.</p>}
      <div className="grid gap-2">{recent.map(parcel => <div key={parcel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-chip bg-white p-3 text-[13px]">
        <span className="font-medium">{parcel.orders.filter(item => item.status === 'fulfilled').map(item => item.order_name).join(' + ')}</span>
        <span>{parcel.carrier} {parcel.tracking_number}</span>
        <span className="text-[12px] text-ink-soft">{parcel.pushed_at ? when(parcel.pushed_at) : ''} · {parcel.pushed_by}</span>
      </div>)}</div>
    </div>

    {confirming && <div role="dialog" aria-modal="true" aria-label="Confirm push" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-card bg-white p-5">
        <h2 className="text-[17px] font-medium">Fulfil {chosenOrders} order{chosenOrders === 1 ? '' : 's'}?</h2>
        <p className="mt-2 text-[13px] text-ink-soft">Shopify emails each customer and the WhatsApp bot sends the shipped message. This cannot be recalled.</p>
        <div className="mt-4 grid gap-2 text-[13px]">{chosen.map(row => <p key={row.order.id}><span className="font-medium">{[row.order.name, ...row.children.map(child => child.orderName)].join(' + ')}</span> → {row.parcel!.carrier} {row.parcel!.tracking_number}</p>)}</div>
        <div className="mt-5 flex justify-end gap-2"><button type="button" className={`${pill} bg-chip`} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className={`${pill} bg-ink text-white`} onClick={push}>Fulfil and notify customers</button></div>
      </div>
    </div>}
  </section>
}
```

- [ ] **Step 4: Implement the page**

```tsx
// src/app/(shell)/dispatch/page.tsx
import { requireOperator } from '@/lib/auth/authorize'
import { ShopifyClient } from '@/lib/shopify/client'
import { dispatchShopifyError, listDispatchOrders } from '@/lib/shopify/dispatch-orders'
import { qcOrderStatuses } from '@/lib/qc/server'
import { listParcels } from '@/lib/dispatch/store'
import { DispatchScreen } from '@/components/dispatch/DispatchScreen'
import type { DispatchOrderSummary, ParcelRow } from '@/lib/dispatch/types'

export const dynamic = 'force-dynamic'

export default async function DispatchPage() {
  await requireOperator()
  let orders: DispatchOrderSummary[] = [], truncated = false, open: ParcelRow[] = [], recent: ParcelRow[] = []
  const problems: string[] = []
  try { ({ orders, truncated } = await listDispatchOrders(new ShopifyClient())) } catch (cause) { problems.push(dispatchShopifyError(cause)) }
  try { ({ open, recent } = await listParcels(30)) } catch (cause) { problems.push(cause instanceof Error ? cause.message : 'Staged numbers could not be loaded.') }
  const ids = [...new Set([...orders.map(order => order.id), ...open.flatMap(parcel => parcel.orders.map(item => item.order_id))])]
  let qcPassed: Record<string, boolean> = {}
  try { const statuses = await qcOrderStatuses(ids); qcPassed = Object.fromEntries(ids.map(id => [id, statuses[id]?.status === 'passed'])) }
  catch { problems.push('QC status could not be loaded, so every QC badge shows as not checked.') }
  return <DispatchScreen orders={orders} qcPassed={qcPassed} open={open} recent={recent} truncated={truncated} error={problems.join(' ') || undefined} />
}
```

- [ ] **Step 5: Add the sidebar entry.** In `src/components/console/Sidebar.tsx`:
  1. Line 21: append `| 'dispatch'` to `SectionKey`. Line 22: append `| '/dispatch'` to `SectionHref`.
  2. Directly after the `{ key: 'qc', href: '/qc', label: 'Order QC', icon: <ListIcon /> },` item add `{ key: 'dispatch', href: '/dispatch', label: 'Dispatch', icon: <ListIcon /> },`.
  3. Change `const active: SectionKey =\n    pathname.startsWith('/qc') ? 'qc' : …` so it begins `pathname.startsWith('/dispatch') ? 'dispatch' : pathname.startsWith('/qc') ? 'qc' : …`; leave the rest of the chain untouched.

- [ ] **Step 6: Run the tests, any test that renders the sidebar, typecheck, lint and build**

Run: `npx vitest run tests/dispatch-screen-render.test.ts $(grep -l "Sidebar" tests/*.test.ts* 2>/dev/null) && npm run typecheck && npm run lint && npm run build`
Expected: 4 render tests PASS; sidebar tests PASS; typecheck, lint and `next build` clean, with `/dispatch` in the build's route list.

- [ ] **Step 7: Commit**

```bash
git add src/components/dispatch/DispatchScreen.tsx "src/app/(shell)/dispatch/page.tsx" src/components/console/Sidebar.tsx tests/dispatch-screen-render.test.ts
git commit -m "feat(dispatch): /dispatch — stage by typing or scanning, + to group a parcel, confirm, push one parcel at a time"
```


---

### Task 10: Docs, full verification, rollout

**Files:**
- Modify: `docs/DECISIONS.md` (append D135), `docs/PROGRESS.md` (new top entry), `CLAUDE.md` ("What it does")

- [ ] **Step 1: Record the decision.** Append to `docs/DECISIONS.md`:

```markdown
### D135 — Dispatch: tracking numbers are staged in Loupe and pushed as Shopify fulfilments (2026-09-21)

Owner: a chat-and-Excel round trip cannot carry this job. `/dispatch` lists open paid orders that have a fulfilment order **In progress** (filtered on the returned fulfilment orders — Shopify rejects `fulfillment_status:in_progress` as a search term). A tracking number typed or scanned against an order is saved as a **parcel** (`dispatch_parcels` + `dispatch_parcel_orders`); `+` adds further orders that travel in the same parcel. Carrier is detected (`ER` India Post · `X`/`D` DTDC · digits Tirupati Courier) and always editable, because `D` is only sometimes DTDC. Push re-reads every order of a parcel first and fulfils none if one is refused; then one `fulfillmentCreate` per order (In-progress fulfilment orders only, `notifyCustomer: true`), sent once through a single-attempt client, and **only a re-read decides the outcome**. A partial unique index keeps an order in one open parcel; a `pushing` claim stops double pushes and is reclaimable after two minutes. The QC badge informs and never blocks. Loupe's own Shopify app gains the two merchant-managed fulfilment-order scopes rather than borrowing the bot's app. Supersedes the undeployed 11 September WhatsApp tracking-sheet flow.
```

- [ ] **Step 2: Add one paragraph to `CLAUDE.md`** at the end of the "What it does" section:

```markdown
**Dispatch** (`/dispatch`, D135) is the last step after QC: operators stage courier tracking numbers against
orders marked In progress in Shopify, group orders that share a parcel, and push — Loupe fulfils each order
with carrier and number and Shopify notifies the customer. It is the only place Loupe writes to orders.
```

- [ ] **Step 3: Full verification.** Run and keep the output for the progress entry:

```bash
npx vitest run tests/dispatch-carrier.test.ts tests/dispatch-orders.test.ts tests/dispatch-plan.test.ts tests/dispatch-push.test.ts tests/dispatch-store.test.ts tests/dispatch-actions.test.ts tests/dispatch-rows.test.ts tests/dispatch-screen-render.test.ts tests/qc-orders.test.ts
npx tsx scripts/verify-dispatch-local-db.ts
npm run typecheck && npm run lint && npm run build
wc -l src/lib/dispatch/*.ts src/lib/shopify/dispatch-orders.ts src/components/dispatch/DispatchScreen.tsx "src/app/(shell)/dispatch/"*.ts*
```
Expected: every test file PASS; `dispatch schema proof: 8 checks passed`; typecheck, lint, build clean; every file under 500 lines.

- [ ] **Step 4: Write the `docs/PROGRESS.md` entry** at the top, using the file's template. Title `## 2026-09-21 — Dispatch: stage tracking numbers, push fulfilments (D135)`. Under **Verified** paste the real output lines from Step 3. Under **Not finished** list exactly the rollout steps below that have not happened yet. Under **Next session should start with** name the first unfinished rollout step.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/PROGRESS.md CLAUDE.md
git commit -m "docs(dispatch): D135, progress entry and the Dispatch paragraph in CLAUDE.md"
```

- [ ] **Step 6: Rollout — each step needs the owner's explicit go-ahead at the time; stop and ask before each.**
  1. **Owner, in Shopify Dev Dashboard:** add `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders` to the Loupe app and re-approve the install. Verify read-only from this Mac with an identity-and-scopes query (`currentAppInstallation { accessScopes { handle } }`) using Loupe's own credentials; both handles must be listed.
  2. **Apply the migration to production** (additive; nothing reads the tables until the deploy): `npx tsx scripts/apply-migration.ts 20260921100000_dispatch.sql <production-env-file> output/dispatch/migration-receipt.json`. Confirm both tables exist and `anon` cannot read them.
  3. **Look before shipping:** `npm run dev` in this worktree, open `/dispatch` at desktop width and at 390 px. The list must contain an order the owner knows is In progress; if it is missing, change the search in `listDispatchOrders` to `` `status:open ${PAID}` `` (drop the `fulfillment_status` clause), update its test, and look again. Typing a number only writes Loupe's own tables. **Do not press Push.**
  4. **Deploy:** merge `claude/dispatch` into `main` and push — this deploys production within a minute. `claude/dispatch` starts from `claude/qc-v2` (`9a2cb93`), so D134 and the material script ship with it if they have not already; say so when asking.
  5. **First live push, owner watching:** one real parcel that is physically ready to ship. Check the Shopify order timeline (fulfilled, carrier, number, "Loupe" as the app), the customer email, and the bot's WhatsApp shipped message. Then one grouped parcel of two orders.
  6. Update the memory vault: `/Users/yash/Desktop/Qimati Memory/systems/loupe.md` (Dispatch, D135, the new scopes), `operations/credential-register.md` (Loupe app scopes), and one `log.md` entry with the evidence from step 5.
