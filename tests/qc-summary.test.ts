import { describe, expect, it } from 'vitest'
import { summarizeQc } from '@/lib/qc/summary'
import type { QcEvent, QcSession } from '@/lib/qc/types'

const line = (id: string, variantId: string, required: number, title = 'Ring', variantTitle = 'Gold / 7') => ({
  id, variantId, title, variantTitle, sku: `${id}-SKU`, barcode: `${id}-SKU`, required,
})

const session = (counts: Record<string, number>, generation = 1): QcSession => ({
  id: 'session',
  order_id: 'gid://shopify/Order/1',
  fingerprint: 'a'.repeat(64),
  snapshot: {
    id: 'gid://shopify/Order/1',
    name: '#Qimati1',
    updatedAt: '2026-09-15T08:00:00Z',
    cancelledAt: null,
    fulfillmentStatus: 'UNFULFILLED',
    blockedReason: null,
    lines: [line('l1', 'v1', 2), line('l2', 'v2', 1, 'Necklace', 'Silver')],
  },
  counts,
  status: 'checking',
  generation,
  version: 1,
  checked_at: '2026-09-15T08:00:00Z',
  completed_at: null,
  completed_by: null,
})

const event = (changes: Partial<QcEvent>): QcEvent => ({
  id: 'e1',
  action: 'scan',
  outcome: 'extra',
  message: 'extra',
  code: 'RS004-C-GOLD-S-8',
  line_id: null,
  variant_id: null,
  actor_id: 'op',
  actor_name: 'Operator',
  created_at: '2026-09-15T08:01:00Z',
  generation: 1,
  undo_of: null,
  ...changes,
})

describe('QC extra and missing wrap-up', () => {
  it('lists missing units until every ordered line is fully scanned', () => {
    const result = summarizeQc(session({ l1: 1 }), [])
    expect(result.missing).toEqual([
      { lineId: 'l1', title: 'Ring', variantTitle: 'Gold / 7', required: 2, checked: 1, short: 0, remaining: 1 },
      { lineId: 'l2', title: 'Necklace', variantTitle: 'Silver', required: 1, checked: 0, short: 0, remaining: 1 },
    ])
    expect(result.canPass).toBe(false)
  })

  it('keeps extras on the wrap-up list until each one is marked removed', () => {
    const extraOnOrder = event({ id: 'extra-1', outcome: 'extra', line_id: 'l1', code: 'RS004-C-GOLD-S-7' })
    const notOnOrder = event({ id: 'wrong-1', outcome: 'wrong', variant_id: 'v99', code: 'NK1414-C-GOLD', line_id: null })
    const result = summarizeQc(session({ l1: 2, l2: 1 }), [extraOnOrder, notOnOrder])
    expect(result.missing).toEqual([])
    expect(result.extras.map(item => ({ id: item.eventId, title: item.title, removed: item.removed, kind: item.kind }))).toEqual([
      { id: 'extra-1', title: 'Ring · Gold / 7', removed: false, kind: 'extra' },
      { id: 'wrong-1', title: 'NK1414-C-GOLD', removed: false, kind: 'wrong' },
    ])
    expect(result.openExtras).toHaveLength(2)
    expect(result.canPass).toBe(false)
  })

  it('lets QC pass only after extras are ticked removed and nothing is missing', () => {
    const extra = event({ id: 'extra-1', outcome: 'extra', line_id: 'l1', code: 'RS004-C-GOLD-S-7' })
    const removed = event({ id: 'rm-1', action: 'clear_extra', outcome: 'removed', undo_of: 'extra-1', code: extra.code })
    const older = event({ id: 'old', outcome: 'wrong', generation: 0, code: 'OLD' })
    const result = summarizeQc(session({ l1: 2, l2: 1 }), [removed, extra, older])
    expect(result.extras).toEqual([expect.objectContaining({ eventId: 'extra-1', removed: true })])
    expect(result.openExtras).toEqual([])
    expect(result.canPass).toBe(true)
  })
})
