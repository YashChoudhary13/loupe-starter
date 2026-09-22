import { countOrders, listOrderIds, OPEN_PAID_QUERY, orderQuery, type ReadOnlyShopify } from './shopify-reads'

export interface HomeNumbers { ordersToday: number | null; paidUnfulfilled: number | null; awaitingQc: number | null; awaitingQcCapped: boolean; awaitingTracking: number | null; openShortages: number | null; problems: string[]; computedAt: string }
export interface NumberDeps { shop: ReadOnlyShopify | null; qcPassed(ids: string[]): Promise<Record<string, boolean>>; openParcels(): Promise<number>; openShortages(): Promise<number>; now: () => Date }

/** The five headline numbers. A check that fails is a null plus a sentence in `problems`; the page never throws over one of them. */
export async function computeNumbers(deps: NumberDeps): Promise<HomeNumbers> {
  const problems: string[] = []
  const attempt = async <T>(label: string, work: () => Promise<T>): Promise<T | null> => { try { return await work() } catch (error) { problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); return null } }
  const shop = deps.shop
  if (!shop) problems.push('Shopify is not configured.')
  const [ordersToday, paidUnfulfilled, awaiting, awaitingTracking, openShortages] = await Promise.all([
    shop ? attempt('orders today', () => countOrders(shop, orderQuery('today', deps.now()))) : null,
    shop ? attempt('paid unfulfilled', () => countOrders(shop, OPEN_PAID_QUERY)) : null,
    shop ? attempt('awaiting QC', async () => { const { ids, truncated } = await listOrderIds(shop, OPEN_PAID_QUERY, 300); const passed = await deps.qcPassed(ids); return { count: ids.filter(id => !passed[id]).length, truncated } }) : null,
    attempt('awaiting tracking', deps.openParcels),
    attempt('open shortages', deps.openShortages),
  ])
  return { ordersToday, paidUnfulfilled, awaitingQc: awaiting?.count ?? null, awaitingQcCapped: awaiting?.truncated ?? false, awaitingTracking, openShortages, problems, computedAt: deps.now().toISOString() }
}
