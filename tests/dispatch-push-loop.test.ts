import { describe, expect, it } from 'vitest'
import { runPush, type PushTarget } from '@/lib/dispatch/push-loop'
import type { PushResult } from '@/lib/dispatch/push'

const target = (n: number): PushTarget => ({ parcelId: `p${n}`, orderId: `o${n}`, orderName: `Qimati${n}` })
const fulfilled = (n: number): PushResult => ({ orderId: `o${n}`, orderName: `Qimati${n}`, status: 'fulfilled', message: 'Fulfilled.' })

describe('runPush', () => {
  it('pushes one parcel at a time, in order, and streams progress after each', async () => {
    const calls: string[] = []
    const progress: PushResult[][] = []
    const results = await runPush([target(1), target(2)], async parcelId => {
      calls.push(parcelId)
      return { ok: true, message: 'ok', results: [fulfilled(Number(parcelId.slice(1)))] }
    }, snapshot => progress.push(snapshot))
    expect(calls).toEqual(['p1', 'p2'])
    expect(results).toEqual([fulfilled(1), fulfilled(2)])
    expect(progress).toEqual([[fulfilled(1)], [fulfilled(1), fulfilled(2)]])
  })

  it('synthesises a failed result from the message when a call reports no results', async () => {
    const results = await runPush([target(1)], async () => ({ ok: false, message: 'Add a tracking number and carrier before pushing.', results: [] }), () => {})
    expect(results).toEqual([{ orderId: 'o1', orderName: 'Qimati1', status: 'failed', message: 'Add a tracking number and carrier before pushing.' }])
  })

  it('stops on a rejection, marks every later parcel not attempted, and resolves rather than throwing', async () => {
    const calls: string[] = []
    const results = await runPush([target(1), target(2), target(3)], async parcelId => {
      calls.push(parcelId)
      if (parcelId === 'p2') throw new Error('network down')
      return { ok: true, message: 'ok', results: [fulfilled(1)] }
    }, () => {})
    expect(calls).toEqual(['p1', 'p2'])
    expect(results).toEqual([
      fulfilled(1),
      { orderId: 'o2', orderName: 'Qimati2', status: 'failed', message: 'Loupe did not get an answer for this parcel. Check the order in Shopify before pushing it again.' },
      { orderId: 'o3', orderName: 'Qimati3', status: 'failed', message: 'Not attempted: the connection failed on an earlier parcel.' },
    ])
  })
})
