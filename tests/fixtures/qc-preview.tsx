// Fictional data and a browser-only API double. Never imports server implementations.
import { createRoot } from 'react-dom/client'
import { AppShell } from '@/components/shell/AppShell'
import { QcScreen } from '@/components/qc/QcScreen'
import { QcHistoryScreen } from '@/components/qc/QcHistoryScreen'
import QcOrdersPage from '@/app/(shell)/qc/page'
import type { QcView, QcCommand, QcEvent, QcShortage, QcPass } from '@/lib/qc/types'

const stamp = '2026-10-02T10:30:00Z'
const operator = { id: 'fixture', email: 'checker@example.test', name: 'Packing team', role: 'operator' as const }
const illustration = (i: number) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="${i % 2 ? '#eee5d8' : '#f0e6e8'}"/><ellipse cx="80" cy="81" rx="39" ry="47" fill="none" stroke="#b18c44" stroke-width="6"/><ellipse cx="80" cy="81" rx="34" ry="42" fill="none" stroke="#e0bd70" stroke-width="2"/><path d="M66 124l14 18 14-18-14-10z" fill="${i % 3 ? '#658071' : '#a67989'}" stroke="#b18c44" stroke-width="3"/></svg>`)
const lines = Array.from({ length: 18 }, (_, i) => ({ id: `gid://shopify/LineItem/${i + 1}`, variantId: `v${i + 1}`, title: ['Necklace 104', 'Rings 028', 'Earrings 216', 'Chain Bracelet 083'][i % 4], variantTitle: ['Gold', 'Silver / 7', 'Rose Gold', 'Green'][i % 4], sku: `DEMO${i + 1}`, barcode: `DEMO${i + 1}`, required: i === 7 ? 3 : 1, image: illustration(i) }))
const order = { id: 'gid://shopify/Order/90001', name: 'Demo90001', updatedAt: stamp, cancelledAt: null, fulfillmentStatus: 'ON_HOLD', blockedReason: null, lines }
const event = (changes: Partial<QcEvent>): QcEvent => ({ id: crypto.randomUUID(), action: 'scan', outcome: 'accepted', message: 'Checked one unit.', code: 'DEMO1', line_id: lines[0].id, variant_id: 'v1', actor_id: operator.id, actor_name: 'Packing team', created_at: stamp, generation: 1, undo_of: null, ...changes })
const shortage: QcShortage = { id: 'short-1', ref: 12, session_id: 'fixture', event_id: 'short-event', order_id: order.id, order_name: order.name, generation: 1, line_id: lines[6].id, variant_id: lines[6].variantId, sku: lines[6].sku, title: lines[6].title, variant_title: lines[6].variantTitle, quantity: 1, reason: 'Not in stock', reported_by: 'Packing team', reported_at: stamp, resolved_at: null, resolved_by: null, resolution: null, resolution_note: null }
const initial: QcView = { order, session: { id: 'fixture', order_id: order.id, fingerprint: 'fixture', snapshot: order, counts: Object.fromEntries(lines.slice(0, 6).map(line => [line.id, 1])), status: 'checking', generation: 1, version: 1, checked_at: stamp, completed_at: null, completed_by: null }, events: [event({ id: 'extra-1', outcome: 'wrong', code: 'EXTRA-GOLD', line_id: null, variant_id: null, message: 'This item is not on the order. Remove it from the box.' })], shortages: [shortage], operatorId: operator.id }
initial.event = initial.events[0]

const summaries = Array.from({ length: 12 }, (_, i) => ({ id: `gid://shopify/Order/${90001 + i}`, name: `Demo${90001 + i}`, createdAt: stamp, updatedAt: stamp, displayFulfillmentStatus: i % 3 ? 'UNFULFILLED' : 'ON_HOLD', displayFinancialStatus: 'PAID' }))
export const listQcOrders = async () => ({ nodes: summaries, pageInfo: { hasNextPage: false, endCursor: null } })
export const qcShopifyError = (error: unknown) => String(error)
export const qcOrderStatuses = async () => Object.fromEntries(summaries.slice(0, 8).map((item, i) => [item.id, { status: i < 4 ? 'passed' : i < 6 ? 'checking' : 'stale', checked_at: stamp, snapshotUpdatedAt: stamp }]))
export const listRecentPasses = async (): Promise<QcPass[]> => summaries.slice(0, 4).map((item, i) => ({ orderId: item.id, orderName: item.name, passedAt: stamp, passedBy: 'Packing team', units: 20, short: i === 0 ? 1 : 0, sessionStatus: 'passed' }))

// API double used by the unchanged real QcScreen. Only this fictional view can be mutated.
const state = structuredClone(initial)
const params = new URLSearchParams(location.search)
if (params.has('ready') || params.has('passed')) {
  state.session.counts = Object.fromEntries(lines.map(line => [line.id, line.required]))
  state.events = []; state.shortages = []; delete state.event
}
if (params.has('passed')) { state.session.status = 'passed'; state.session.completed_at = stamp }
if (params.has('shipping')) { state.order.fulfillmentStatus = 'UNFULFILLED' }
window.fetch = async (input, init) => {
  if (!String(input).startsWith('/api/qc/')) throw new Error('Only fictional QC requests are allowed.')
  await new Promise(resolve => setTimeout(resolve, 40))
  if (init?.method === 'POST') {
    const command = JSON.parse(String(init.body)) as QcCommand
    let next = event({ action: command.action, id: command.requestId })
    if (command.action === 'scan') {
      const line = lines.find(line => line.barcode === command.code)
      if (!line) next = event({ id: command.requestId, outcome: 'wrong', code: command.code, line_id: null, variant_id: null, message: 'Wrong item — remove it from this order’s box.' })
      else if ((state.session.counts[line.id] ?? 0) >= line.required) next = event({ id: command.requestId, outcome: 'extra', code: command.code, line_id: line.id, variant_id: line.variantId, message: 'Extra unit — remove it from this order’s box.' })
      else {
        state.session.counts[line.id] = (state.session.counts[line.id] ?? 0) + 1
        state.shortages = state.shortages.filter(item => item.line_id !== line.id)
        next = event({ id: command.requestId, code: command.code, line_id: line.id, variant_id: line.variantId, message: `Checked 1 unit: ${line.title} · ${line.variantTitle}` })
      }
    } else if (command.action === 'clear_extra') next = event({ action: command.action, outcome: 'removed', undo_of: command.extraEventId, message: 'Extra item confirmed removed.' })
    else if (command.action === 'short') {
      const line = lines.find(line => line.id === command.lineId)!
      next = event({ action: 'short', outcome: 'short', line_id: line.id, message: 'Missing units accepted as short.' })
      state.shortages.push({ ...shortage, id: next.id, event_id: next.id, ref: 13, line_id: line.id, title: line.title, variant_title: line.variantTitle, quantity: line.required - (state.session.counts[line.id] ?? 0), reason: command.reason! })
    } else if (command.action === 'undo') {
      const target = state.events.find(item => item.id === command.undoEventId)
      state.shortages = state.shortages.filter(item => item.event_id !== command.undoEventId)
      if (target?.outcome === 'accepted' && target.line_id) state.session.counts[target.line_id]--
      next = event({ action: 'undo', outcome: 'undone', undo_of: command.undoEventId, message: 'Correction saved.' })
    } else if (command.action === 'reset') {
      state.session.generation++; state.session.counts = {}; state.session.status = 'checking'; state.shortages = []
      next = event({ action: 'reset', outcome: 'reset', generation: state.session.generation, message: 'Fresh checklist started.' })
    } else if (command.action === 'complete') {
      state.session.status = 'passed'; state.session.completed_at = stamp
      next = event({ action: 'complete', outcome: 'passed', message: 'QC passed.' })
    }
    state.event = next; state.events.unshift(next); state.session.version++
    state.timings = { totalMs: 240, shopifyMs: 0, rpcMs: 200, snapshotAgeMs: 800 }
  }
  return Response.json(state)
}

async function render() {
  const content = location.pathname === '/qc' ? await QcOrdersPage({ searchParams: Promise.resolve({}) })
    : params.has('history') ? <QcHistoryScreen session={state.session} events={state.events} shortages={state.shortages} />
    : <QcScreen initialView={structuredClone(state)} />
  createRoot(document.getElementById('root')!).render(<AppShell operator={operator} face="qc" initialAttentionCount={0} initialCollapsed={params.has('collapsed') || document.cookie.split('; ').includes('loupe_nav_collapsed=1')}>{content}</AppShell>)
}
void render()
