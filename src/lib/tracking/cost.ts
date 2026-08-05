/**
 * Money arithmetic for the tracking read model.
 *
 * Kept out of `read-model.ts` because that module is `server-only` and cannot
 * be imported by tests. These are the two operations where a quiet bug
 * misreports spend against the ~₹5,000/month budget, so they are pure and
 * directly tested.
 */

/**
 * PostgREST returns `numeric(12,6)` as a string to avoid float rounding. Parse
 * defensively: an unreadable figure must not silently become 0, which would
 * under-report spend. Null and undefined mean "nothing billed", not "free".
 */
export function usd(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Sum provider-reported amounts exactly.
 *
 * Adds in micro-dollars because `numeric(12,6)` is exact to six decimal places
 * while float addition puts `0.07362399999999999` in the operator's face.
 *
 * Returns null when nothing has been billed. That is deliberately different
 * from 0, which would claim a paid call returned free — the same NULL-vs-0
 * distinction the schema draws for `default_weight_g` (D19).
 */
export function sumUsd(parts: readonly (number | null)[]): number | null {
  const billed = parts.filter((part): part is number => part !== null)
  if (billed.length === 0) return null
  return billed.reduce((total, part) => total + Math.round(part * 1_000_000), 0) / 1_000_000
}
