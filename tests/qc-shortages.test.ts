import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ serverEnv: { qcBotSecret: 'a'.repeat(64), authBaseUrl: 'https://loupe.example' } }))
vi.mock('@/lib/shopify/client', () => ({ ShopifyClient: class { config = { storeDomain: 'qc-test.myshopify.com' } } }))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: mocks.from }) }))
import { summarizeQc } from '@/lib/qc/summary'
import { parseResolveInput, resolveShortage } from '@/lib/qc/shortages'
import { toneForOutcome } from '@/lib/qc/sound'
import { POST } from '@/app/api/qc/shortages/route'
import type { QcSession, QcShortage } from '@/lib/qc/types'

const session = (counts: Record<string, number>): QcSession => ({
  id: 'session', order_id: 'gid://shopify/Order/1', fingerprint: 'a'.repeat(64), counts, status: 'checking', generation: 2, version: 3, checked_at: '2026-09-18T08:00:00Z', completed_at: null, completed_by: null,
  snapshot: { id: 'gid://shopify/Order/1', name: 'Qimati1', updatedAt: '2026-09-18T08:00:00Z', cancelledAt: null, fulfillmentStatus: 'UNFULFILLED', blockedReason: null, lines: [
    { id: 'l1', variantId: 'v1', title: 'Ring', variantTitle: 'Gold / 7', sku: 'RS004-C-GOLD-S-7', barcode: 'RS004-C-GOLD-S-7', required: 3 },
    { id: 'l2', variantId: 'v2', title: 'Necklace', variantTitle: null, sku: 'NK1', barcode: 'NK1', required: 1 },
  ] },
})
const shortage = (changes: Partial<QcShortage>): QcShortage => ({
  id: 's1', ref: 12, session_id: 'session', event_id: 'e1', order_id: 'gid://shopify/Order/1', order_name: 'Qimati1', generation: 2, line_id: 'l1', variant_id: 'v1', sku: 'RS004-C-GOLD-S-7', title: 'Ring', variant_title: 'Gold / 7',
  quantity: 1, reason: 'not in stock', reported_by: 'Checker', reported_at: '2026-09-18T08:01:00Z', resolved_at: null, resolved_by: null, resolution: null, resolution_note: null, ...changes,
})

describe('QC shortage summary', () => {
  it('lets an accepted shortage stand in for missing units, but only in the current checklist and only while open', () => {
    const base = summarizeQc(session({ l1: 2, l2: 1 }), [])
    expect(base.missing).toEqual([{ lineId: 'l1', title: 'Ring', variantTitle: 'Gold / 7', required: 3, checked: 2, short: 0, remaining: 1 }])
    expect(base.canPass).toBe(false)
    const accepted = summarizeQc(session({ l1: 2, l2: 1 }), [], [shortage({})])
    expect(accepted.missing).toEqual([])
    expect(accepted.shortByLine).toEqual({ l1: 1 })
    expect(accepted.canPass).toBe(true)
    expect(summarizeQc(session({ l1: 2, l2: 1 }), [], [shortage({ generation: 1 })]).canPass).toBe(false)
    expect(summarizeQc(session({ l1: 2, l2: 1 }), [], [shortage({ resolved_at: '2026-09-18T09:00:00Z', resolution: 'cancelled' })]).canPass).toBe(false)
  })
  it('still requires every unit when the shortage covers less than the gap', () => {
    const result = summarizeQc(session({ l1: 0, l2: 1 }), [], [shortage({ quantity: 2 })])
    expect(result.missing).toEqual([{ lineId: 'l1', title: 'Ring', variantTitle: 'Gold / 7', required: 3, checked: 0, short: 2, remaining: 1 }])
  })
  it('maps outcomes to tones so the scanner operator hears the result', () => {
    expect(toneForOutcome('accepted')).toBe('accept')
    expect(toneForOutcome('short')).toBe('accept')
    expect(toneForOutcome('passed')).toBe('passed')
    for (const bad of ['rejected', 'extra', 'wrong', 'conflict', 'stale', 'incomplete', 'extras']) expect(toneForOutcome(bad)).toBe('reject')
    expect(toneForOutcome('opened')).toBeNull()
    expect(toneForOutcome(undefined)).toBeNull()
  })
})

describe('Shortage resolution', () => {
  it('validates the reference, staff resolutions and resolver', () => {
    expect(parseResolveInput({ ref: '#12', resolution: 'Refund', note: 'x'.repeat(300), by: 'WhatsApp 7401' })).toEqual({ ref: 12, resolution: 'refund', note: 'x'.repeat(240), by: 'WhatsApp 7401' })
    expect(parseResolveInput({ ref: 3, resolution: 'coupon', by: 'Yash' }).note).toBeNull()
    expect(() => parseResolveInput({ ref: 'abc', resolution: 'refund', by: 'x' })).toThrow(/shortage number/)
    expect(() => parseResolveInput({ ref: 1, resolution: 'found', by: 'x' })).toThrow(/refund, coupon, shipped, other/)
    expect(() => parseResolveInput({ ref: 1, resolution: 'cancelled', by: 'x' })).toThrow(/resolved/)
    expect(() => parseResolveInput({ ref: 1, resolution: 'refund', by: '  ' })).toThrow(/resolver/)
  })
  it('resolves an open row once and reports an already-resolved row without changing it', async () => {
    const open = shortage({})
    const done = shortage({ resolved_at: '2026-09-18T09:00:00Z', resolved_by: 'Other', resolution: 'coupon' })
    const update = vi.fn()
    let row: QcShortage = open
    mocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
      update: (fields: Record<string, unknown>) => { update(fields); return { eq: () => ({ is: () => ({ select: () => ({ maybeSingle: async () => ({ data: { ...row, ...fields }, error: null }) }) }) }) } },
    }))
    const first = await resolveShortage({ ref: 12, resolution: 'refund', note: 'UPI ref 1', by: 'Yash' })
    expect(first.changed).toBe(true)
    expect(first.shortage.resolution).toBe('refund')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ resolved_by: 'Yash', resolution: 'refund', resolution_note: 'UPI ref 1' }))
    row = done
    const second = await resolveShortage({ ref: 12, resolution: 'refund', by: 'Yash' })
    expect(second).toEqual({ shortage: done, changed: false })
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('Bot shortage endpoint', () => {
  const request = (body: unknown, token: string | null = 'a'.repeat(64)) => new Request('http://localhost:3000/api/qc/shortages', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  beforeEach(() => { vi.resetAllMocks() })
  it('fails closed without the bot secret and never reaches the database', async () => {
    expect((await POST(request({ action: 'list' }, null))).status).toBe(401)
    expect((await POST(request({ action: 'list' }, 'b'.repeat(64)))).status).toBe(401)
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('lists open and recently resolved shortages for the bot', async () => {
    mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({
      is: () => ({ order: () => ({ limit: async () => ({ data: [shortage({})], error: null }) }) }),
      gte: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
    }) }) }))
    const response = await POST(request({ action: 'list' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, open: [shortage({})], resolved: [] })
  })
  it('rejects unknown actions, oversized and malformed bodies', async () => {
    expect((await POST(request({ action: 'delete' }))).status).toBe(400)
    expect((await POST(request('{'))).status).toBe(400)
    expect((await POST(request('x'.repeat(5000)))).status).toBe(413)
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('records the WhatsApp resolver, not a browser-supplied name', async () => {
    const update = vi.fn()
    mocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: shortage({}), error: null }) }) }) }),
      update: (fields: Record<string, unknown>) => { update(fields); return { eq: () => ({ is: () => ({ select: () => ({ maybeSingle: async () => ({ data: { ...shortage({}), ...fields }, error: null }) }) }) }) } },
    }))
    const response = await POST(request({ action: 'resolve', ref: 12, resolution: 'coupon', note: 'QR-500-ABCDE', by: '7401', resolved_by: 'attacker' }))
    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ resolved_by: 'WhatsApp 7401', resolution: 'coupon', resolution_note: 'QR-500-ABCDE' }))
    expect((await POST(request({ action: 'resolve', ref: 12, resolution: 'lost' }))).status).toBe(400)
  })
})
