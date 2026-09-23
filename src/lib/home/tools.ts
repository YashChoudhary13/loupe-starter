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
