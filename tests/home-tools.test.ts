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
