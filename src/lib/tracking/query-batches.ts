/**
 * Keep PostgREST `.in(...)` filters below the HTTP header limit.
 *
 * Supabase serialises an IN filter into the request URL. A few hundred UUIDs
 * are enough to push that URL beyond Undici's 16 KB header ceiling, which made
 * Tracking fail once the intake history grew past roughly 400 photographs.
 */
export const POSTGREST_IN_BATCH_SIZE = 100

export function queryBatches<T>(
  values: readonly T[],
  size: number = POSTGREST_IN_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('Query batch size must be a positive integer.')
  }

  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}
