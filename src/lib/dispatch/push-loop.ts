import type { PushResult } from './push'

export interface PushTarget { parcelId: string; orderId: string; orderName: string }

/**
 * Strictly serial: one parcel per `pushOne` call, in order, streaming progress after each.
 * `pushOne` rejecting (a dropped connection or session redirect, not a logical refusal — those
 * come back as `{ok:false}` and already carry results) stops the loop but never throws: the
 * failed parcel and every parcel after it are recorded as failed, so the operator can always see
 * exactly who was — and was not — notified.
 */
export async function runPush(
  targets: readonly PushTarget[],
  pushOne: (parcelId: string) => Promise<{ ok: boolean; message: string; results: PushResult[] }>,
  onProgress: (results: PushResult[]) => void,
): Promise<PushResult[]> {
  const all: PushResult[] = []
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    try {
      const outcome = await pushOne(target.parcelId)
      all.push(...(outcome.results.length ? outcome.results : [{ orderId: target.orderId, orderName: target.orderName, status: 'failed' as const, message: outcome.message }]))
    } catch {
      all.push({ orderId: target.orderId, orderName: target.orderName, status: 'failed', message: 'Loupe did not get an answer for this parcel. Check the order in Shopify before pushing it again.' })
      for (const rest of targets.slice(i + 1)) all.push({ orderId: rest.orderId, orderName: rest.orderName, status: 'failed', message: 'Not attempted: the connection failed on an earlier parcel.' })
      onProgress([...all])
      return all
    }
    onProgress([...all])
  }
  return all
}
