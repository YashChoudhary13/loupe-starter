import { describe, expect, it } from 'vitest'
import { confirmsPush, planPush } from '@/lib/dispatch/plan'
import type { DispatchFulfillmentOrder, DispatchOrderSnapshot } from '@/lib/dispatch/types'

const fo = (changes: Partial<DispatchFulfillmentOrder> = {}): DispatchFulfillmentOrder => ({ id: 'fo1', status: 'IN_PROGRESS', canFulfil: true, remaining: 3, locationId: 'loc1', complete: true, ...changes })
const order = (changes: Partial<DispatchOrderSnapshot> = {}): DispatchOrderSnapshot => ({ id: 'gid://shopify/Order/1', name: 'Qimati1', closed: false, cancelledAt: null, fulfillmentOrders: [fo()], fulfillmentOrdersComplete: true, fulfillments: [], ...changes })
const done = (company: string, number: string, status = 'SUCCESS') => ({ id: 'f1', status, tracking: [{ company, number }] })
const reason = (snapshot: DispatchOrderSnapshot) => { const plan = planPush(snapshot, 'DTDC', 'X1234567'); return plan.kind === 'refuse' ? plan.reason : plan.kind }

describe('planPush', () => {
  it('fulfils every eligible In-progress fulfilment order and nothing else', () => {
    expect(planPush(order({ fulfillmentOrders: [fo(), fo({ id: 'fo2', status: 'OPEN' }), fo({ id: 'fo3' }), fo({ id: 'fo4', status: 'ON_HOLD' })] }), 'DTDC', 'X1234567')).toEqual({ kind: 'fulfil', fulfillmentOrderIds: ['fo1', 'fo3'] })
  })
  it('refuses cancelled and archived orders', () => { expect(reason(order({ cancelledAt: '2026-09-21T00:00:00Z' }))).toMatch(/cancelled/); expect(reason(order({ closed: true }))).toMatch(/archived/) })
  it('refuses when nothing is In progress, naming a hold', () => {
    expect(reason(order({ fulfillmentOrders: [fo({ status: 'OPEN' })] }))).toMatch(/Mark it In progress/)
    expect(reason(order({ fulfillmentOrders: [fo({ status: 'ON_HOLD' })] }))).toMatch(/on hold/)
    expect(reason(order({ fulfillmentOrders: [fo({ remaining: 0 })] }))).toMatch(/Mark it In progress/)
    expect(reason(order({ fulfillmentOrders: [fo({ canFulfil: false })] }))).toMatch(/Mark it In progress/)
  })
  it('counts an identical existing fulfilment as done', () => { expect(planPush(order({ fulfillmentOrders: [fo({ status: 'CLOSED', remaining: 0 })], fulfillments: [done('DTDC', 'X1234567')] }), 'DTDC', 'X1234567')).toEqual({ kind: 'done', fulfillmentId: 'f1' }) })
  it('never overwrites a different tracking number', () => { expect(reason(order({ fulfillmentOrders: [fo({ status: 'CLOSED', remaining: 0 })], fulfillments: [done('India Post', 'ER999999999IN')] }))).toMatch(/already fulfilled with India Post ER999999999IN/) })
  it('ignores a cancelled fulfilment', () => { expect(planPush(order({ fulfillments: [done('DTDC', 'X1234567', 'CANCELLED')] }), 'DTDC', 'X1234567').kind).toBe('fulfil') })
  it('fulfils the In-progress remainder of a partly shipped order', () => { expect(planPush(order({ fulfillments: [done('India Post', 'ER111111111IN')] }), 'DTDC', 'X1234567')).toEqual({ kind: 'fulfil', fulfillmentOrderIds: ['fo1'] }) })
  it('refuses what it cannot see completely or fulfil in one call', () => {
    expect(reason(order({ fulfillmentOrdersComplete: false }))).toMatch(/too large/)
    expect(reason(order({ fulfillmentOrders: [fo({ complete: false })] }))).toMatch(/too large/)
    expect(reason(order({ fulfillmentOrders: [fo(), fo({ id: 'fo2', locationId: 'loc2' })] }))).toMatch(/two locations/)
  })
})
describe('confirmsPush', () => {
  it('needs a successful fulfilment with exactly the sent company and number', () => {
    expect(confirmsPush(order({ fulfillments: [done('DTDC', 'X1234567')] }), 'DTDC', 'X1234567')).toBe('f1')
    expect(confirmsPush(order({ fulfillments: [done('DTDC', 'X1234567', 'PENDING')] }), 'DTDC', 'X1234567')).toBeNull()
    expect(confirmsPush(order({ fulfillments: [done('DTDC', 'X7654321')] }), 'DTDC', 'X1234567')).toBeNull()
    expect(confirmsPush(order({ fulfillments: [{ id: 'f1', status: 'SUCCESS', tracking: [{ company: 'DTDC', number: 'X1234567' }, { company: 'DTDC', number: 'X2' }] }] }), 'DTDC', 'X1234567')).toBeNull()
  })
})
