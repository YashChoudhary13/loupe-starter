import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), view: vi.fn(), resolve: vi.fn(), sessions: vi.fn(), prior: vi.fn(), authorize: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { config = { storeDomain: 'qc-test.myshopify.com' } } }))
vi.mock('@/lib/shopify/club-orders', () => ({ listClubOrders: mocks.list }))
vi.mock('@/lib/qc/server', () => ({ loadQcView: mocks.view, resolveQcCode: mocks.resolve }))
vi.mock('@/lib/auth/authorize', () => ({ requireOperatorIdForAction: mocks.authorize, NotAuthorisedError: class extends Error {} }))
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://loupe.example' } }))
// qc_sessions answers `.in()`, qc_events answers `.limit()`.
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) chain[method] = () => chain
  chain.in = () => table === 'qc_sessions' ? mocks.sessions() : chain
  chain.limit = () => mocks.prior()
  return chain
} }) }))
import { clearClubCache, clubScan, clubsOf, loadClubView, loadClubs, pickScanTarget, type ClubSession } from '@/lib/qc/club'
import { GET, POST } from '@/app/api/qc/club/[orderId]/route'
import type { SlipOrder } from '@/lib/slips/types'

const gid = (n: number) => `gid://shopify/Order/${n}`
const order = (n: number, phone: string, over: Partial<SlipOrder> = {}): SlipOrder => ({ id: gid(n), name: `Qimati${n}`, createdAt: '', note: null, tags: [], email: null, phone, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', total: 0,
  customer: null, shippingAddress: { name: `Buyer ${phone.slice(-2)}`, phone: null, address1: null, address2: null, city: null, provinceCode: null, zip: null, country: null }, billingAddress: null, fulfillmentOrders: [], lines: [], ...over })
const line = (id: string, variantId: string, required: number) => ({ id, variantId, title: id, variantTitle: null, sku: id, barcode: id, required })
const session = (n: number, status: string, lines: ReturnType<typeof line>[], counts: Record<string, number> = {}): ClubSession => ({ id: `s${n}`, order_id: gid(n), status, generation: n, counts, snapshot: { lines } })
const operator = { id: 'op' }
const scan = { action: 'scan' as const, requestId: 'f9c6a240-bef7-4db4-9e09-0a8bc0f6fbe5', code: 'RS1', expectedGeneration: 1 }

beforeEach(() => {
  vi.resetAllMocks(); clearClubCache()
  mocks.authorize.mockResolvedValue(operator)
  mocks.list.mockResolvedValue([order(7949, '9000000001'), order(7831, '9000000001'), order(7900, '9000000002')])
  mocks.view.mockImplementation(async (id: string) => ({ order: { id }, session: {}, events: [], shortages: [] }))
  mocks.resolve.mockResolvedValue({ variantId: 'v1', rejection: null })
  mocks.prior.mockResolvedValue({ data: [], error: null })
})

describe('club grouping', () => {
  it('clubs the same customer by the packing-list rules, oldest order first, and leaves a single order alone', () => {
    const clubs = clubsOf([order(7949, '9000000001'), order(7831, '9000000001'), order(7900, '9000000002')])
    expect(clubs.get(gid(7949))).toEqual({ ids: [gid(7831), gid(7949)], numbers: [7831, 7949], customer: 'Buyer 01' })
    expect(clubs.get(gid(7831))).toEqual(clubs.get(gid(7949)))
    expect(clubs.has(gid(7900))).toBe(false)
  })
  it('never clubs an unpaid order, exactly as Print slips', () => {
    expect(clubsOf([order(1001, '9000000001'), order(1002, '9000000001', { financialStatus: 'PENDING' })]).size).toBe(0)
  })
  it('reads fresh for a page and reuses the read for scans', async () => {
    await loadClubs(); await loadClubs(false); await loadClubs(false)
    expect(mocks.list).toHaveBeenCalledTimes(1)
    await loadClubs()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
  it('opens every member, and answers null for an order that is not clubbed', async () => {
    const club = await loadClubView('7949', operator)
    expect(club?.members.map(member => member.order.id)).toEqual([gid(7831), gid(7949)])
    expect(club?.customer).toBe('Buyer 01')
    expect(await loadClubView('7900', operator)).toBeNull()
  })
})

describe('which order a scan counts in', () => {
  const rs = line('L1', 'v1', 2)
  it('fills the oldest unfinished order that still needs the piece, then the next', () => {
    const older = session(1, 'checking', [rs], { L1: 1 }), newer = session(2, 'checking', [line('L2', 'v1', 1)])
    expect(pickScanTarget([older, newer], 'v1')).toBe(older)
    expect(pickScanTarget([{ ...older, counts: { L1: 2 } }, newer], 'v1')).toBe(newer)
  })
  it('never scans into an order that already passed while another is unfinished', () => {
    const passed = session(1, 'passed', [rs], { L1: 2 }), fresh = session(2, 'checking', [line('L2', 'v1', 1)])
    expect(pickScanTarget([passed, fresh], 'v1')).toBe(fresh)
    // Not needed anywhere: recorded as an extra on the unfinished order, not on the passed one.
    expect(pickScanTarget([passed, session(2, 'checking', [line('L2', 'v2', 1)])], 'v1')?.order_id).toBe(gid(2))
  })
  it('skips an order that changed in Shopify, and records an unknown code on the unfinished order', () => {
    const stale = session(1, 'stale', [rs]), fresh = session(2, 'checking', [line('L2', 'v1', 1)])
    expect(pickScanTarget([stale, fresh], 'v1')).toBe(fresh)
    expect(pickScanTarget([stale, fresh], null)).toBe(fresh)
  })
  it('when every order has passed, an extra goes to the one that carries the variant', () => {
    const a = session(1, 'passed', [line('L1', 'v9', 1)]), b = session(2, 'passed', [line('L2', 'v1', 1)])
    expect(pickScanTarget([a, b], 'v1')).toBe(b)
    expect(pickScanTarget([a, b], 'nope')).toBe(a)
  })
})

describe('club scan', () => {
  const rows = () => ({ data: [session(7949, 'checking', [line('L2', 'v1', 1)]), session(7831, 'checking', [line('L1', 'v1', 1)])], error: null })
  it('counts in the oldest member with that member\'s generation', async () => {
    mocks.sessions.mockResolvedValue(rows())
    await clubScan('7949', operator, scan)
    expect(mocks.view).toHaveBeenCalledWith(gid(7831), operator, { ...scan, expectedGeneration: 7831 })
  })
  it('sends a retried request back to the order it counted in the first time', async () => {
    mocks.sessions.mockResolvedValue(rows())
    mocks.prior.mockResolvedValue({ data: [{ session_id: 's7949' }], error: null })
    await clubScan('7831', operator, scan)
    expect(mocks.view).toHaveBeenCalledWith(gid(7949), operator, { ...scan, expectedGeneration: 7949 })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('creates the checklist of a member nobody opened yet before choosing', async () => {
    mocks.sessions.mockResolvedValueOnce({ data: [session(7949, 'checking', [line('L2', 'v1', 1)])], error: null }).mockResolvedValue(rows())
    await clubScan('7949', operator, scan)
    expect(mocks.view.mock.calls[0]).toEqual([gid(7831), operator])
    expect(mocks.view).toHaveBeenLastCalledWith(gid(7831), operator, expect.objectContaining({ action: 'scan' }))
  })
  it('refuses an order that is no longer clubbed', async () => {
    await expect(clubScan('7900', operator, scan)).rejects.toThrow('no longer clubbed')
  })
})

describe('club route', () => {
  const context = (id: string) => ({ params: Promise.resolve({ orderId: id }) })
  const request = (body: unknown, origin = 'https://loupe.example') => new Request('http://localhost:3000/api/qc/club/7949', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  it('takes a scan without a generation and nothing else', async () => {
    mocks.sessions.mockResolvedValue({ data: [session(7831, 'checking', [line('L1', 'v1', 1)]), session(7949, 'checking', [])], error: null })
    expect((await POST(request({ action: 'scan', requestId: scan.requestId, code: 'RS1' }), context('7949'))).status).toBe(200)
    expect((await POST(request({ action: 'complete', requestId: scan.requestId, expectedVersion: 1 }), context('7949'))).status).toBe(400)
    expect((await POST(request({ action: 'scan', requestId: scan.requestId, code: 'RS1' }, 'https://other.example'), context('7949'))).status).toBe(403)
  })
  it('answers 409 for an order with no club', async () => {
    expect((await GET(new Request('http://localhost:3000/api/qc/club/7900'), context('7900'))).status).toBe(409)
    expect((await GET(new Request('http://localhost:3000/api/qc/club/7949'), context('7949'))).status).toBe(200)
  })
})
