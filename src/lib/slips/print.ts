import { carriersFor, gujarat, pinOf, type CarrierCheck } from './carrier'
import { contactPhones, isHeld, notePhones, num, paid, plan } from './plan'
import { NEED_ADDRESS, type Mark, type Progress, type SlipDocumentRow, type SlipOrder, type SlipPrintRow, type SlipRow, type SlipStrip } from './types'

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
  /** The courier for a six-digit pincode with what each checker said (D162); carrier null when it could not be settled. Never throws. */
  carrierFor(pin: string): Promise<CarrierCheck>
  /** Customers whose every parcel goes by Delhivery, as phone digits with country code (owner, 2026-11-25). Kept in the server's env, never in the code. */
  delhiveryPhones?: ReadonlySet<string>
}
export interface Selection { rows: SlipRow[]; baseline: SlipOrder[]; leftOut: string[]; truncated: boolean; unprinted: number }
/** `rows` and `orders` are what the click printed, so the document is rendered from them without reading Shopify again. */
export interface PrintOutcome { batchId: string | null; printed: number; baseline: number; marks: Record<Mark, number>; failed: { name: string; error: string }[]; leftOut: string[]; printedAt: string; rows: SlipDocumentRow[]; orders: SlipOrder[] }
/** How many orders are told to Shopify at once. One after another cost about half a second each on the first live clicks (2026-10-16); eight at a time stays far under the API's cost bucket, and the client retries a throttle anyway. */
const MARK_AT_ONCE = 8
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

/** Writes the courier on each row's strip and answers with what the checkers said, by pincode (D162). A slip still
 * waiting for its address carries no courier; a customer on the owner's Delhivery list goes by Delhivery whatever the
 * destination, Gujarat included, with no pincode check; a Gujarat parcel goes by Tirupati without a check. */
export async function setCouriers(rows: readonly SlipRow[], deps: Pick<PrintDeps, 'carrierFor' | 'delhiveryPhones'>): Promise<Map<string, CarrierCheck>> {
  const byDelhivery = (row: SlipRow) => !!deps.delhiveryPhones?.size && [...contactPhones(row.order), ...notePhones(row.order)].some(phone => deps.delhiveryPhones!.has(phone))
  const pinToCheck = (row: SlipRow) => (row.strip.flags.includes(NEED_ADDRESS) || byDelhivery(row) || gujarat(row.order) ? null : pinOf(row.order))
  const carriers = await carriersFor(rows.map(pinToCheck).filter((pin): pin is string => pin !== null), deps.carrierFor)
  for (const row of rows) {
    if (row.strip.flags.includes(NEED_ADDRESS)) continue
    if (byDelhivery(row)) { row.strip.carrier = 'Delhivery'; continue }
    if (gujarat(row.order)) { row.strip.carrier = 'Tirupati'; continue }
    // No slip goes out unchecked (owner, 2026-11-25): an address without a six-digit Indian pincode says CHECK COURIER, never a silent DTDC.
    const pin = pinOf(row.order)
    row.strip.carrier = pin ? carriers.get(pin)?.carrier ?? null : null
  }
  return carriers
}

export interface ReprintDeps extends Pick<PrintDeps, 'readOrders' | 'carrierFor' | 'delhiveryPhones'> {
  loadRow(orderNumber: number): Promise<SlipPrintRow | null>
  saveStrip(rowId: string, strip: SlipStrip): Promise<void>
}
export class NoSuchSlip extends Error { constructor(message: string) { super(message); this.name = 'NoSuchSlip' } }
/** One order's slip again (D181). A slip printed as Need Address whose order has its address by now loses that word and
 * gets its courier, and the stored strip is updated so every later reprint says the same; any other slip prints as stored. */
export async function reprintOne(orderNumber: number, deps: ReprintDeps): Promise<{ row: SlipPrintRow; order: SlipOrder; refreshed: boolean }> {
  const stored = await deps.loadRow(orderNumber)
  if (!stored || stored.mark === 'BASELINE') throw new NoSuchSlip(`Qimati${orderNumber} has no slip printed from Loupe.`)
  const [order] = await deps.readOrders([stored.order_id])
  if (!order) throw new NoSuchSlip(`Qimati${orderNumber} could not be read from Shopify.`)
  if (!stored.strip.flags.includes(NEED_ADDRESS) || !order.shippingAddress?.address1) return { row: stored, order, refreshed: false }
  const row: SlipRow = { order, mark: stored.mark, strip: { ...stored.strip, flags: stored.strip.flags.filter(flag => flag !== NEED_ADDRESS) } }
  await setCouriers([row], deps)
  await deps.saveStrip(stored.id, row.strip)
  return { row: { ...stored, strip: row.strip }, order, refreshed: true }
}

export async function printSlips(by: string, fromNumber: number | null, deps: PrintDeps): Promise<PrintOutcome> {
  const started = Date.now()
  const selection = await select(deps, fromNumber)
  if (selection.truncated) throw new Error('Shopify has more open orders than Loupe read in one go, so the list is incomplete and nothing was printed. Archive old fulfilled orders in Shopify and try again.')
  if (!selection.rows.length && !selection.baseline.length) throw new NothingToPrint(selection.leftOut.length ? `Nothing new to print. Left out, payment not received: ${selection.leftOut.join(', ')}.` : undefined)
  // The courier, by pincode, before the rows are stored: the strip is kept as printed, so a reprint says the same (D162).
  // A slip still waiting for its address carries no courier (owner, 2026-10-29), whatever pincode it has; a Gujarat parcel
  // goes by Tirupati without a check.
  const checking = Date.now()
  const carriers = await setCouriers(selection.rows, deps)
  // Every pin not going by DTDC is written into the print record with both checkers' words, so a courier line can be audited.
  const checks = [...carriers].filter(([, check]) => check.carrier !== 'DTDC').map(([pin, check]) => ({ pin, ...check }))
  const batching = Date.now()
  const batchId = await deps.createBatch({ by, fromNumber })
  const wanted: NewPrintRow[] = [
    ...selection.rows.map(row => ({ orderId: row.order.id, orderName: row.order.name, orderNumber: num(row.order.name), mark: row.mark, strip: row.strip })),
    ...selection.baseline.map(o => ({ orderId: o.id, orderName: o.name, orderNumber: num(o.name), mark: 'BASELINE' as const, strip: { detail: 'printed before Loupe', flags: [], how: [], heldWith: [], with: [] } })),
  ]
  const inserted = await deps.insertRows(batchId, wanted)
  const rows = selection.rows.filter(row => inserted.has(row.order.id))
  await deps.finishBatch(batchId, rows.length)
  const printedAt = new Date().toISOString(), marking = Date.now()
  // 2. Shopify, a few orders at a time, after the rows exist: a failure here is shown on the page by order number, never silent.
  const note = `Packing slip printed from Loupe by ${by}`
  const results: { progress: Progress; error: string | null }[] = []
  for (let start = 0; start < rows.length; start += MARK_AT_ONCE) {
    results.push(...await Promise.all(rows.slice(start, start + MARK_AT_ONCE).map(async row => {
      const result = await markInProgress(row.order, row.mark, note, deps.reportProgress)
      await deps.setProgress(batchId, row.order.id, result.progress, result.error)
      return result
    })))
  }
  const failed = rows.flatMap((row, i) => { const error = results[i]?.error; return error ? [{ name: row.order.name, error }] : [] })
  const outcome: PrintOutcome = {
    batchId, printed: rows.length, baseline: selection.baseline.filter(o => inserted.has(o.id)).length, marks: countMarks(rows), failed, leftOut: selection.leftOut, printedAt,
    rows: rows.map((row, i) => ({ order_id: row.order.id, order_name: row.order.name, order_number: num(row.order.name), mark: row.mark, strip: row.strip, progress: results[i]?.progress ?? 'failed' })),
    orders: rows.map(row => row.order),
  }
  const couriers: Record<string, number> = {}
  for (const row of rows) { const key = row.strip.carrier ?? (row.strip.carrier === null ? 'unchecked' : 'no pin'); couriers[key] = (couriers[key] ?? 0) + 1 }
  await deps.record(batchId, 'slips.printed', { printed: outcome.printed, baseline: outcome.baseline, marks: outcome.marks, couriers, checks, failed: failed.map(item => item.name), fromNumber, skippedAsTaken: wanted.length - inserted.size, ms: { read: checking - started, courier: batching - checking, mark: Date.now() - marking } }, by)
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
