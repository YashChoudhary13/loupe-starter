import { describe, expect, it, vi } from 'vitest'
import { computeNumbers, NUMBERS_TIMEOUT_MS } from '@/lib/home/numbers'
import { COUNT_QUERY, ORDER_IDS_QUERY, OPEN_PAID_QUERY, orderQuery, type ReadOnlyShopify } from '@/lib/home/shopify-reads'

const shop = (counts: Record<string, number>, ids: string[]): ReadOnlyShopify => ({ readOnly: true, async graphql<T>(query: string, variables?: Record<string, unknown>) {
  if (query === COUNT_QUERY) return { ordersCount: { count: counts[String(variables?.query)] ?? 0, precision: 'EXACT' } } as T
  if (query === ORDER_IDS_QUERY) return { orders: { nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } } } as T
  throw new Error(`unexpected query ${query}`)
} })
const now = () => new Date('2026-09-23T20:30:00Z') // 02:00 IST on the 24th

describe('home numbers', () => {
  it('counts today in IST, paid unfulfilled, awaiting QC (open minus passed), open parcels and open shortages', async () => {
    const client = shop({ [orderQuery('today', now())]: 4, [OPEN_PAID_QUERY]: 12 }, ['gid://shopify/Order/1', 'gid://shopify/Order/2', 'gid://shopify/Order/3'])
    const numbers = await computeNumbers({ shop: client, qcPassed: async ids => ({ [ids[0]]: true }), openParcels: async () => 5, openShortages: async () => 2, now })
    expect(numbers).toMatchObject({ ordersToday: 4, paidUnfulfilled: 12, awaitingQc: 2, awaitingQcCapped: false, awaitingTracking: 5, openShortages: 2, problems: [], computedAt: '2026-09-23T20:30:00.000Z' })
  })
  it('a failed check is a null with its reason, never a thrown page', async () => {
    const client: ReadOnlyShopify = { readOnly: true, async graphql() { throw new Error('Shopify 502') } }
    const numbers = await computeNumbers({ shop: client, qcPassed: async () => ({}), openParcels: async () => { throw new Error('db down') }, openShortages: async () => 0, now })
    expect(numbers).toMatchObject({ ordersToday: null, paidUnfulfilled: null, awaitingQc: null, awaitingTracking: null, openShortages: 0 })
    expect(numbers.problems).toEqual(expect.arrayContaining([expect.stringContaining('Shopify 502'), expect.stringContaining('db down')]))
  })
  it('without Shopify configured the Shopify numbers are null and it says so', async () => {
    const numbers = await computeNumbers({ shop: null, qcPassed: async () => ({}), openParcels: async () => 0, openShortages: async () => 0, now })
    expect(numbers.ordersToday).toBeNull(); expect(numbers.problems).toContain('Shopify is not configured.')
  })
  it('a stalled Shopify read times out instead of hanging the page', async () => {
    vi.useFakeTimers()
    try {
      const client: ReadOnlyShopify = { readOnly: true, async graphql() { return new Promise(() => {}) } }
      const pending = computeNumbers({ shop: client, qcPassed: async () => ({}), openParcels: async () => 5, openShortages: async () => 2, now })
      await vi.advanceTimersByTimeAsync(NUMBERS_TIMEOUT_MS + 1)
      const numbers = await pending
      expect(numbers).toMatchObject({ ordersToday: null, awaitingTracking: 5, openShortages: 2 })
      expect(numbers.problems).toContain('orders today: timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})
