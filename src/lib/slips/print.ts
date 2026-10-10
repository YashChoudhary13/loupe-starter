import { isHeld, num, paid, plan } from './plan'
import type { Mark, Progress, SlipOrder, SlipRow, SlipStrip } from './types'

/** One click of Print slips, with every side effect behind `deps` so the sequence is testable without Shopify or a database. */
export interface NewPrintRow { orderId: string; orderName: string; orderNumber: number; mark: Mark | 'BASELINE'; strip: SlipStrip }
export interface PrintDeps {
  listOpenOrders(): Promise<{ orders: SlipOrder[]; truncated: boolean }>
  readOrders(ids: readonly string[]): Promise<SlipOrder[]>
  /** Which of these orders already have a slip row. */
  printedOrderIds(ids: readonly string[]): Promise<Set<string>>
  createBatch(input: { by: string; fromNumber: number | null }): Promise<string>
  /** Inserts what it can; an order another click took meanwhile is skipped. Returns the order ids that were inserted. */
  insertRows(batchId: string, rows: readonly NewPrintRow[]): Promise<Set<string>>
  finishBatch(batchId: string, orderCount: number): Promise<void>
  setProgress(batchId: string, orderId: string, progress: Progress, error: string | null): Promise<void>
  reportProgress(fulfillmentOrderId: string, note: string): Promise<void>
  record(batchId: string, event: string, detail: Record<string, unknown>, by: string): Promise<void>
}
export interface Selection { rows: SlipRow[]; baseline: SlipOrder[]; leftOut: string[]; truncated: boolean; unprinted: number }
export interface PrintOutcome { batchId: string | null; printed: number; baseline: number; marks: Record<Mark, number>; failed: { name: string; error: string }[]; leftOut: string[] }
export class NothingToPrint extends Error { constructor(message = 'Nothing new to print.') { super(message); this.name = 'NothingToPrint' } }

/** The orders this click would print: open, paid, no slip yet, and at or above `fromNumber` when one is given.
 * Orders below it have no slip either (printed before Loupe); they become baseline rows so they never print later. */
export async function select(deps: Pick<PrintDeps, 'listOpenOrders' | 'printedOrderIds'>, fromNumber: number | null): Promise<Selection> {
  const { orders, truncated } = await deps.listOpenOrders()
  const printed = await deps.printedOrderIds(orders.map(order => order.id))
  const fresh = (o: SlipOrder) => !printed.has(o.id)
  const inRange = (o: SlipOrder) => fresh(o) && (fromNumber === null || num(o.name) >= fromNumber)
  const rows = plan(orders, inRange)
  const baseline = fromNumber === null ? [] : orders.filter(o => fresh(o) && paid(o) && num(o.name) < fromNumber).sort((a, b) => num(a.name) - num(b.name))
  const leftOut = orders.filter(o => inRange(o) && !paid(o)).sort((a, b) => num(a.name) - num(b.name)).map(o => `${o.name} (${o.financialStatus.replace(/_/g, ' ').toLowerCase()})`)
  return { rows, baseline, leftOut, truncated, unprinted: orders.filter(o => fresh(o) && paid(o)).length }
}

const countMarks = (rows: readonly { mark: Mark | 'BASELINE' }[]): Record<Mark, number> => ({ PACK: 0, HOLD: 0, CLUB: 0, 'CLUB + HOLD': 0, ...Object.fromEntries(rows.filter(row => row.mark !== 'BASELINE').map(row => [row.mark, rows.filter(other => other.mark === row.mark).length])) }) as Record<Mark, number>

/** Tells Shopify one order is being packed. Only the fulfilment orders still OPEN are touched; a held order is never marked. */
export async function markInProgress(order: SlipOrder, mark: Mark | 'BASELINE', note: string, report: PrintDeps['reportProgress']): Promise<{ progress: Progress; error: string | null }> {
  if (mark === 'BASELINE' || isHeld(mark)) return { progress: 'not_needed', error: null }
  const open = order.fulfillmentOrders.filter(fo => fo.status === 'OPEN')
  if (!open.length) return { progress: order.fulfillmentOrders.some(fo => fo.status === 'IN_PROGRESS') ? 'already' : 'not_needed', error: null }
  for (const fo of open) {
    try { await report(fo.id, note) }
    catch (cause) { return { progress: 'failed', error: cause instanceof Error ? cause.message : 'Shopify did not answer.' } }
  }
  return { progress: 'marked', error: null }
}

export async function printSlips(by: string, fromNumber: number | null, deps: PrintDeps): Promise<PrintOutcome> {
  const selection = await select(deps, fromNumber)
  if (selection.truncated) throw new Error('Shopify has more open orders than Loupe read in one go, so the list is incomplete and nothing was printed. Archive old fulfilled orders in Shopify and try again.')
  if (!selection.rows.length && !selection.baseline.length) throw new NothingToPrint(selection.leftOut.length ? `Nothing new to print. Left out, payment not received: ${selection.leftOut.join(', ')}.` : undefined)
  const batchId = await deps.createBatch({ by, fromNumber })
  const wanted: NewPrintRow[] = [
    ...selection.rows.map(row => ({ orderId: row.order.id, orderName: row.order.name, orderNumber: num(row.order.name), mark: row.mark, strip: row.strip })),
    ...selection.baseline.map(o => ({ orderId: o.id, orderName: o.name, orderNumber: num(o.name), mark: 'BASELINE' as const, strip: { detail: 'printed before Loupe', flags: [], how: [], heldWith: [], with: [] } })),
  ]
  const inserted = await deps.insertRows(batchId, wanted)
  const rows = selection.rows.filter(row => inserted.has(row.order.id))
  await deps.finishBatch(batchId, rows.length)
  // 2. Shopify, one order at a time, after the rows exist: a failure here is shown on the page by order number, never silent.
  const failed: { name: string; error: string }[] = []
  for (const row of rows) {
    const result = await markInProgress(row.order, row.mark, `Packing slip printed from Loupe by ${by}`, deps.reportProgress)
    await deps.setProgress(batchId, row.order.id, result.progress, result.error)
    if (result.error) failed.push({ name: row.order.name, error: result.error })
  }
  const outcome: PrintOutcome = { batchId, printed: rows.length, baseline: selection.baseline.filter(o => inserted.has(o.id)).length, marks: countMarks(rows), failed, leftOut: selection.leftOut }
  await deps.record(batchId, 'slips.printed', { printed: outcome.printed, baseline: outcome.baseline, marks: outcome.marks, failed: failed.map(item => item.name), fromNumber, skippedAsTaken: wanted.length - inserted.size }, by)
  return outcome
}

/** Marks again every order of a batch whose In-progress write failed. */
export async function retryProgress(batchId: string, rows: readonly { order_id: string; order_name: string; mark: Mark | 'BASELINE'; progress: Progress }[], by: string, deps: Pick<PrintDeps, 'readOrders' | 'setProgress' | 'reportProgress' | 'record'>): Promise<{ fixed: number; failed: { name: string; error: string }[] }> {
  const pending = rows.filter(row => row.progress === 'failed')
  if (!pending.length) return { fixed: 0, failed: [] }
  const orders = new Map((await deps.readOrders(pending.map(row => row.order_id))).map(order => [order.id, order]))
  const failed: { name: string; error: string }[] = []
  let fixed = 0
  for (const row of pending) {
    const order = orders.get(row.order_id)
    const result = order ? await markInProgress(order, row.mark, `Packing slip printed from Loupe by ${by}`, deps.reportProgress) : { progress: 'failed' as const, error: 'Shopify could not return this order.' }
    await deps.setProgress(batchId, row.order_id, result.progress, result.error)
    if (result.error) failed.push({ name: row.order_name, error: result.error }); else fixed++
  }
  await deps.record(batchId, 'slips.progress_retried', { fixed, failed: failed.map(item => item.name) }, by)
  return { fixed, failed }
}
