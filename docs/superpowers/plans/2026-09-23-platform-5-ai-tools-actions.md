# Qimati Platform — Implementation Plan, part 5 of 8 (read tools, confirm-gated actions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read part 1 (`2026-09-23-platform-1-faces-auth.md`) first: its **Global Constraints** bind every task here — above all: **the assistant reads only**. Its Shopify route is the `ReadOnlyShopify` wrapper (Task 8), every query is a constant, no customer field is ever requested, and the only actions are three WhatsApp-bot calls that the model can *propose* and only an operator can *confirm*.

---

### Task 9: The read tools

**Files:**
- Create: `src/lib/home/tools.ts`
- Modify: `src/lib/home/server.ts` (add `homeToolContext()`)
- Test: `tests/home-tools.test.ts`

**Interfaces:**
- Consumes: `ReadOnlyShopify`, `listOrders`, `lowStock`, `orderQuery`, `ORDER_FILTERS` (Task 8); `N8nClient` (Task 6); `ProbeLight` (Task 7); `HomeNumbers` (Task 8); `QcPass`, `QcShortage` (`src/lib/qc/types.ts`); `ParcelRow` (`src/lib/dispatch/types.ts`).
- Produces: `ToolContext`, `JsonSchema`, `ToolDef`, `boundedInt(value, min, max, fallback)`, `oneOf(value, allowed, fallback)`, `READ_TOOLS`, `toolSpecs(tools)`, `runTool(tools, name, args, ctx)`; `homeToolContext(): ToolContext` (server).

- [ ] **Step 1: Write the failing test**

```ts
// tests/home-tools.test.ts
import { describe, expect, it } from 'vitest'
import { boundedInt, oneOf, READ_TOOLS, runTool, toolSpecs, type ToolContext } from '@/lib/home/tools'
import { LOW_STOCK_QUERY, OPEN_PAID_QUERY, ORDERS_QUERY } from '@/lib/home/shopify-reads'

const order = (n: number) => ({ id: `gid://shopify/Order/${n}`, name: `Qimati${n}`, createdAt: '2026-09-23T05:00:00Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', subtotalLineItemsQuantity: n, totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'INR' } } })
const parcel = (n: number, status = 'staged') => ({ id: `p${n}`, tracking_number: 'X1234567', carrier: 'DTDC', carrier_source: 'auto', staged_by: 'op', staged_at: '2026-09-23T05:00:00Z', pushed_by: null, pushed_at: null, orders: [{ id: `r${n}`, parcel_id: `p${n}`, order_id: `gid://shopify/Order/${n}`, order_name: `Qimati${n}`, position: 0, status, fulfillment_id: null, error: null, push_started_at: null, finished_at: null }] })
function context(): ToolContext & { calls: { query: string; variables?: Record<string, unknown> }[] } {
  const calls: { query: string; variables?: Record<string, unknown> }[] = []
  return {
    calls,
    shop: { readOnly: true as const, async graphql<T>(query: string, variables?: Record<string, unknown>) { calls.push({ query, variables }); return (query === LOW_STOCK_QUERY ? { productVariants: { nodes: [{ sku: 'RS004-C-GOLD', title: 'Gold', inventoryQuantity: 0, product: { title: 'Rings 004' } }] } } : { orders: { nodes: [order(1), order(2), order(3)] } }) as T } },
    n8n: { async workflow(id) { return { id, name: 'Main', active: true } }, async executions(id, limit) { return [{ id: `${id}-1`, status: 'success', startedAt: null, stoppedAt: null }].slice(0, limit) } },
    workflows: { 'Main bot': 'abc' },
    now: () => new Date('2026-09-23T10:00:00Z'),
    status: async () => ({ lights: [], numbers: { ordersToday: 1, paidUnfulfilled: 2, awaitingQc: 3, awaitingQcCapped: false, awaitingTracking: 4, openShortages: 5, problems: [], computedAt: 'now' } }),
    qcPassed: async ids => ({ [ids[0]]: true }),
    passes: async () => [{ orderId: 'gid://shopify/Order/9', orderName: 'Qimati9', passedAt: '2026-09-22T05:00:00Z', passedBy: 'Checker', units: 12, short: 1, sessionStatus: 'passed' }],
    shortages: async () => ({ open: [{ ref: 3, order_name: 'Qimati9', title: 'Rings 004', variant_title: 'Gold', quantity: 1, reported_at: '2026-09-22T05:00:00Z' } as never], resolved: [] }),
    parcels: async () => ({ open: [parcel(1), parcel(2, 'failed')] as never, recent: [{ ...parcel(7, 'fulfilled'), pushed_at: '2026-09-22T09:00:00Z', pushed_by: 'owner' }] as never }),
  }
}
const run = (name: string, args: Record<string, unknown>, ctx = context()) => runTool(READ_TOOLS, name, args, ctx).then(text => ({ result: JSON.parse(text), ctx }))

describe('read tools', () => {
  it('list_orders builds the documented query per filter and caps the limit at 50', async () => {
    const { ctx } = await run('list_orders', { filter: 'unfulfilled', limit: 500 })
    expect(ctx.calls[0]).toEqual({ query: ORDERS_QUERY, variables: { query: OPEN_PAID_QUERY, first: 50 } })
    const today = await run('list_orders', { filter: 'today' })
    expect(String(today.ctx.calls[0].variables?.query)).toMatch(/^created_at:>='2026-09-23T00:00:00\+05:30' -status:cancelled$/)
    expect(today.result).toHaveLength(3); expect(Object.keys(today.result[0]).sort()).toEqual(['createdAt', 'fulfilment', 'items', 'name', 'payment', 'total'])
  })
  it('awaiting_qc drops passed orders; awaiting_tracking comes from parcels and never touches Shopify', async () => {
    const qc = await run('list_orders', { filter: 'awaiting_qc' })
    expect(qc.result.map((row: { name: string }) => row.name)).toEqual(['Qimati2', 'Qimati3'])
    const tracking = await run('list_orders', { filter: 'awaiting_tracking' })
    expect(tracking.ctx.calls).toHaveLength(0)
    expect(tracking.result).toEqual([{ order: 'Qimati1', status: 'staged', carrier: 'DTDC', tracking: 'X1234567' }, { order: 'Qimati2', status: 'failed', carrier: 'DTDC', tracking: 'X1234567' }])
  })
  it('an unknown filter falls back to unfulfilled; bounds are enforced on every number', async () => {
    const { ctx } = await run('list_orders', { filter: 'DROP TABLE', limit: -3 })
    expect(ctx.calls[0].variables).toEqual({ query: OPEN_PAID_QUERY, first: 1 })
    expect(boundedInt('7', 1, 50, 20)).toBe(7); expect(boundedInt(999, 1, 50, 20)).toBe(50); expect(boundedInt('x', 1, 50, 20)).toBe(20); expect(boundedInt(2.9, 1, 50, 20)).toBe(2)
    expect(oneOf('today', ['today', 'on_hold'] as const, 'on_hold')).toBe('today'); expect(oneOf(7, ['today'] as const, 'today')).toBe('today')
  })
  it('low_stock caps the threshold at 20 and returns sku, product, variant, quantity', async () => {
    const { result, ctx } = await run('low_stock', { threshold: 99, limit: 5 })
    expect(ctx.calls[0].variables).toEqual({ query: 'inventory_quantity:<=20 product_status:active', first: 5 })
    expect(result).toEqual([{ sku: 'RS004-C-GOLD', product: 'Rings 004', variant: 'Gold', quantity: 0 }])
  })
  it('qc_summary and dispatch_summary summarise Loupe records with no customer data', async () => {
    const qc = (await run('qc_summary', { days: 90 })).result
    expect(qc).toMatchObject({ days: 30, passed: 1, units: 12, withShortages: 1, openShortages: 1, resolvedShortages: 0 })
    expect(qc.open[0]).toEqual({ ref: 3, order: 'Qimati9', item: 'Rings 004', variant: 'Gold', quantity: 1, reportedAt: '2026-09-22T05:00:00Z' })
    const dispatch = (await run('dispatch_summary', {})).result
    expect(dispatch).toMatchObject({ days: 7, openParcels: 2, staged: 2, pushed: 1, failedOrders: 1 })
    expect(dispatch.recent[0]).toEqual({ carrier: 'DTDC', tracking: 'X1234567', orders: ['Qimati7'], pushedAt: '2026-09-22T09:00:00Z' })
  })
  it('dispatch_summary counts a failed order once even when its parcel also appears in recent', async () => {
    const mixed = { ...parcel(8, 'fulfilled'), pushed_at: '2026-09-22T09:00:00Z', pushed_by: 'owner', orders: [...parcel(8, 'fulfilled').orders, { id: 'r8b', parcel_id: 'p8', order_id: 'gid://shopify/Order/8b', order_name: 'Qimati8b', position: 1, status: 'failed', fulfillment_id: null, error: 'no stock', push_started_at: null, finished_at: null }] }
    const ctx = context()
    ctx.parcels = async () => ({ open: [mixed] as never, recent: [mixed] as never })
    const dispatch = (await run('dispatch_summary', {}, ctx)).result
    expect(dispatch.failedOrders).toBe(1)
  })
  it('awaiting_qc appends a note when the newest-250 page comes back full', async () => {
    const ctx = context()
    ctx.shop = { readOnly: true as const, async graphql<T>(query: string, variables?: Record<string, unknown>) { ctx.calls.push({ query, variables }); return { orders: { nodes: Array.from({ length: 250 }, (_, i) => order(i + 1)) } } as T } }
    ctx.qcPassed = async () => ({})
    const { result } = await run('list_orders', { filter: 'awaiting_qc' }, ctx)
    expect(ctx.calls[0].variables).toEqual({ query: OPEN_PAID_QUERY, first: 250 })
    expect(result).toHaveLength(21)
    expect(result[20]).toEqual({ note: 'Only the newest 250 open orders were checked; older ones may also be waiting. The Awaiting QC number on the dashboard covers 300.' })
  })
  it('bot_status reports each configured workflow; bot_executions refuses an unknown label', async () => {
    expect((await run('bot_status', {})).result).toEqual([{ workflow: 'Main bot', active: true, lastRun: { id: 'abc-1', status: 'success', startedAt: null, stoppedAt: null } }])
    expect((await run('bot_executions', { workflow: 'Main bot', limit: 99 })).result).toHaveLength(1)
    expect((await run('bot_executions', { workflow: 'Other' })).result).toEqual({ error: 'Unknown workflow. Configured: Main bot.' })
  })
  it('get_status returns the snapshot; a tool failure is an error object, never a throw; unknown tools are refused', async () => {
    expect((await run('get_status', {})).result.numbers.awaitingQc).toBe(3)
    const broken = context(); broken.shop = null
    expect((await run('low_stock', {}, broken)).result).toEqual({ error: 'Shopify is not configured.' })
    expect(JSON.parse(await runTool(READ_TOOLS, 'delete_everything', {}, context()))).toEqual({ error: 'No tool named delete_everything.' })
  })
  it('describes every tool to the model as a function with a closed schema, and none can write', () => {
    const specs = toolSpecs(READ_TOOLS)
    expect(specs.map(spec => spec.function.name)).toEqual(['get_status', 'list_orders', 'low_stock', 'qc_summary', 'dispatch_summary', 'bot_status', 'bot_executions'])
    for (const spec of specs) { expect(spec.type).toBe('function'); expect(spec.function.parameters.additionalProperties).toBe(false) }
    expect(JSON.stringify(READ_TOOLS.map(tool => tool.description))).not.toMatch(/write|update|create|delete|cancel|refund/i)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/home-tools.test.ts`
Expected: FAIL — cannot resolve `@/lib/home/tools`.

- [ ] **Step 3: Implement the tools**

```ts
// src/lib/home/tools.ts
import type { ParcelRow } from '@/lib/dispatch/types'
import type { QcPass, QcShortage } from '@/lib/qc/types'
import type { N8nClient } from './n8n'
import type { HomeNumbers } from './numbers'
import type { ProbeLight } from './probes'
import { listOrders, lowStock, orderQuery, ORDER_FILTERS, type ReadOnlyShopify } from './shopify-reads'

/** Everything a tool may reach. Shopify only through the read-only wrapper; Loupe records through the existing readers. */
export interface ToolContext {
  shop: ReadOnlyShopify | null
  n8n: N8nClient | null
  workflows: Record<string, string>
  now: () => Date
  status(): Promise<{ lights: ProbeLight[]; numbers: HomeNumbers }>
  qcPassed(ids: string[]): Promise<Record<string, boolean>>
  passes(days: number): Promise<QcPass[]>
  shortages(days: number): Promise<{ open: QcShortage[]; resolved: QcShortage[] }>
  parcels(days: number): Promise<{ open: ParcelRow[]; recent: ParcelRow[] }>
}
export interface JsonSchema { type: 'object'; properties: Record<string, { type: string; description?: string; enum?: readonly string[]; minimum?: number; maximum?: number }>; required?: string[]; additionalProperties: false }
export interface ToolDef { name: string; description: string; parameters: JsonSchema; run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> }

/** The model supplies parameters, never query text; every number is clamped and every choice is one of a fixed list. */
export function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T { return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback }
const needsShop = (ctx: ToolContext): ReadOnlyShopify => { if (!ctx.shop) throw new Error('Shopify is not configured.'); return ctx.shop }
const days = (value: unknown, fallback: number) => boundedInt(value, 1, 30, fallback)

export const READ_TOOLS: readonly ToolDef[] = [
  { name: 'get_status', description: 'Current health lights of every service and the five headline numbers. Already in your context; call only to refresh.', parameters: { type: 'object', properties: {}, additionalProperties: false }, run: (_args, ctx) => ctx.status() },
  { name: 'list_orders', description: 'Shopify orders by filter: unfulfilled (paid, open), awaiting_qc (checks the newest 250 open orders), awaiting_tracking (staged in Dispatch), today, on_hold. Returns order number, date, payment and fulfilment status, total and item count only.',
    parameters: { type: 'object', properties: { filter: { type: 'string', enum: ORDER_FILTERS }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['filter'], additionalProperties: false },
    async run(args, ctx) {
      const filter = oneOf(args.filter, ORDER_FILTERS, 'unfulfilled'), limit = boundedInt(args.limit, 1, 50, 20)
      if (filter === 'awaiting_tracking') return (await ctx.parcels(30)).open.flatMap(parcel => parcel.orders.map(item => ({ order: item.order_name, status: item.status, carrier: parcel.carrier, tracking: parcel.tracking_number }))).slice(0, limit)
      const { rows, ids } = await listOrders(needsShop(ctx), orderQuery(filter, ctx.now()), filter === 'awaiting_qc' ? 250 : limit)
      if (filter !== 'awaiting_qc') return rows
      const passed = await ctx.qcPassed(ids)
      const waiting = rows.filter((_, index) => !passed[ids[index]]).slice(0, limit)
      return rows.length === 250 ? [...waiting, { note: 'Only the newest 250 open orders were checked; older ones may also be waiting. The Awaiting QC number on the dashboard covers 300.' }] : waiting
    } },
  { name: 'low_stock', description: 'Active product variants at or below a stock threshold (default 5, at most 20).', parameters: { type: 'object', properties: { threshold: { type: 'integer', minimum: 0, maximum: 20 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    run: (args, ctx) => lowStock(needsShop(ctx), boundedInt(args.threshold, 0, 20, 5), boundedInt(args.limit, 1, 50, 20)) },
  { name: 'qc_summary', description: 'Order QC over the last N days (default 7, at most 30): passed checklists, units, shortages open and resolved.', parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
    async run(args, ctx) {
      const n = days(args.days, 7)
      const [passes, shortages] = await Promise.all([ctx.passes(n), ctx.shortages(n)])
      return { days: n, passed: passes.length, units: passes.reduce((sum, pass) => sum + pass.units, 0), withShortages: passes.filter(pass => pass.short > 0).length, openShortages: shortages.open.length, resolvedShortages: shortages.resolved.length,
        open: shortages.open.slice(0, 20).map(item => ({ ref: item.ref, order: item.order_name, item: item.title, variant: item.variant_title, quantity: item.quantity, reportedAt: item.reported_at })) }
    } },
  { name: 'dispatch_summary', description: 'Dispatch over the last N days (default 7, at most 30): open parcels, staged numbers, pushed parcels, failed orders, recent pushes.', parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
    async run(args, ctx) {
      const n = days(args.days, 7)
      const { open, recent } = await ctx.parcels(n)
      return { days: n, openParcels: open.length, staged: open.filter(parcel => parcel.tracking_number).length, pushed: recent.length, failedOrders: open.flatMap(parcel => parcel.orders).filter(item => item.status === 'failed').length,
        recent: recent.slice(0, 20).map(parcel => ({ carrier: parcel.carrier, tracking: parcel.tracking_number, orders: parcel.orders.map(item => item.order_name), pushedAt: parcel.pushed_at })) }
    } },
  { name: 'bot_status', description: 'Whether each configured WhatsApp-bot workflow is active in n8n, with its last run.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const n8n = ctx.n8n
      if (!n8n) return { error: 'n8n is not configured.' }
      return Promise.all(Object.entries(ctx.workflows).map(async ([label, id]) => {
        try { const [workflow, runs] = await Promise.all([n8n.workflow(id), n8n.executions(id, 1)]); return { workflow: label, active: workflow.active, lastRun: runs[0] ?? null } }
        catch (error) { return { workflow: label, error: error instanceof Error ? error.message : 'unreachable' } }
      }))
    } },
  { name: 'bot_executions', description: 'Recent n8n runs of one configured workflow, by its label (see bot_status). At most 20.', parameters: { type: 'object', properties: { workflow: { type: 'string', description: 'A configured workflow label' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['workflow'], additionalProperties: false },
    run(args, ctx) {
      const id = ctx.workflows[String(args.workflow ?? '')]
      if (!id) throw new Error(`Unknown workflow. Configured: ${Object.keys(ctx.workflows).join(', ') || 'none'}.`)
      if (!ctx.n8n) throw new Error('n8n is not configured.')
      return ctx.n8n.executions(id, boundedInt(args.limit, 1, 20, 10))
    } },
]

/** The OpenAI-style function list the model sees. */
export function toolSpecs(tools: readonly { name: string; description: string; parameters: JsonSchema }[]) {
  return tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}
/** Runs one tool for the model. Never throws: a failure is `{ error }` text the model can read out. Output capped so one answer cannot flood the context. */
export async function runTool(tools: readonly ToolDef[], name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = tools.find(item => item.name === name)
  if (!tool) return JSON.stringify({ error: `No tool named ${name}.` })
  try { return JSON.stringify(await tool.run(args, ctx)).slice(0, 12_000) } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'The tool failed.' }) }
}
```

Add to `src/lib/home/server.ts` (imports: `listRecentPasses` from `@/lib/qc/server`, `workflowMap` from `./n8n`, `type ToolContext` from `./tools`):
```ts
/** What the assistant's tools may reach. Shopify only through the read-only wrapper; nothing here can write. */
export function homeToolContext(): ToolContext {
  return {
    shop: homeReadOnlyShopify(), n8n: n8nFromEnv(), workflows: workflowMap(process.env.HOME_N8N_WORKFLOWS), now: () => new Date(),
    status: async () => { const snapshot = await homeSnapshot(); return { lights: snapshot.lights, numbers: snapshot.numbers } },
    qcPassed, passes: listRecentPasses, shortages: listShortages, parcels: listParcels,
  }
}
```

- [ ] **Step 4: Run the test, typecheck, lint**

Run: `npx vitest run tests/home-tools.test.ts && npm run typecheck && npx eslint src/lib/home/tools.ts src/lib/home/server.ts tests/home-tools.test.ts`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/home/tools.ts src/lib/home/server.ts tests/home-tools.test.ts
git commit -m "feat(home): seven read tools — typed parameters, constant queries, no customer field, never a write"
```

---

### Task 10: The three actions, hidden until connected, executed only on a confirmed one-time token

**Files:**
- Create: `src/lib/home/actions.ts`
- Modify: `src/lib/home/server.ts` (snapshot gains `actionsConnected`), `.env.local.example` (add `BOT_REPORT_WEBHOOK_URL`, `BOT_STAFF_TEXT_WEBHOOK_URL`, `BOT_WEBHOOK_SECRET`)
- Test: `tests/home-actions.test.ts`

**Interfaces:**
- Consumes: `encodeSignedValue`, `decodeSignedValue`, `randomToken` (`src/lib/auth/session.ts`); `WebhookPost` (Task 6); `JsonSchema` (Task 9).
- Produces: `BotConfig`, `botConfig(env?)`, `ActionParams`, `ActionDef`, `STAFF_TEXT_MAX`, `formatListAsText(title, rows)`, `ACTIONS`, `availableActions(config)`, `ConfirmPayload`, `CONFIRM_TTL_SECONDS`, `issueConfirmToken(secret, { uid, action, params }, nowSeconds?)`, `readConfirmToken(secret, token, uid, nowSeconds?)`, `consumeNonce(nonce, expSeconds, nowSeconds?)`, `resetNonces()`; `HomeSnapshot.actionsConnected`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/home-actions.test.ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/home-actions.test.ts`
Expected: FAIL — cannot resolve `@/lib/home/actions`.

- [ ] **Step 3: Implement**

```ts
// src/lib/home/actions.ts
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
```

In `src/lib/home/server.ts`: import `availableActions, botConfig` from `./actions`; extend `HomeSnapshot` with `actionsConnected: boolean` and return `actionsConnected: availableActions(botConfig()).length > 0` from `homeSnapshot()`.

Append to `.env.local.example`, under the Home dashboard section:
```
# The three confirm-gated bot actions stay hidden from the assistant until these exist (a WhatsApp-bot change with its own approval).
# BOT_REPORT_WEBHOOK_URL=https://n8n.example.com/webhook/loupe-finance-report
# BOT_STAFF_TEXT_WEBHOOK_URL=https://n8n.example.com/webhook/loupe-staff-text
# BOT_WEBHOOK_SECRET=replace-me   # sent as X-Loupe-Secret; the bot must check it
```

- [ ] **Step 4: Run the test, typecheck, lint**

Run: `npx vitest run tests/home-actions.test.ts tests/home-tools.test.ts && npm run typecheck && npx eslint src/lib/home/actions.ts src/lib/home/server.ts tests/home-actions.test.ts`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/home/actions.ts src/lib/home/server.ts .env.local.example tests/home-actions.test.ts
git commit -m "feat(home): three bot actions — validated, hidden until connected, executed only on a confirmed single-use token"
```
