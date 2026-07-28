import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function required(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) throw new Error(`Missing ${key} — tests need real credentials in .env`)
  return v
}

export const SUPABASE_URL = required('NEXT_PUBLIC_SUPABASE_URL')
export const SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY')

/** Privileged client. Bypasses RLS, which is how the server talks to the database. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Browser-equivalent client, subject to RLS. Used to prove it can reach nothing. */
export function publishableClient(): SupabaseClient {
  return createClient(SUPABASE_URL, required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface RpcOutcome {
  readonly ok: boolean
  readonly value: number | null
  readonly status: number
  readonly error: { message?: string; code?: string; hint?: string } | null
  readonly startedAt: number
  readonly finishedAt: number
}

/**
 * Calls a Postgres function over PostgREST with the service-role key.
 *
 * Raw fetch rather than supabase-js so the call is as thin as possible: no
 * client-side queueing, no retries, no shared state between the 100 calls the
 * concurrency test fires at once. Start and finish timestamps come back so the
 * test can prove the calls genuinely overlapped rather than quietly queueing.
 */
export async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcOutcome> {
  const startedAt = performance.now()
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    })
    const finishedAt = performance.now()
    const text = await res.text()

    if (!res.ok) {
      let error: RpcOutcome['error'] = { message: text }
      try {
        error = JSON.parse(text) as RpcOutcome['error']
      } catch {
        /* PostgREST returned something that is not JSON; keep the raw text. */
      }
      return { ok: false, value: null, status: res.status, error, startedAt, finishedAt }
    }

    return {
      ok: true,
      value: JSON.parse(text) as number,
      status: res.status,
      error: null,
      startedAt,
      finishedAt,
    }
  } catch (e) {
    return {
      ok: false,
      value: null,
      status: 0,
      error: { message: e instanceof Error ? e.message : String(e) },
      startedAt,
      finishedAt: performance.now(),
    }
  }
}

/** Reads a counter directly, for before/after assertions. */
export async function readCounter(prefix: string): Promise<number> {
  const { data, error } = await serviceClient()
    .from('sku_counters')
    .select('last_number')
    .eq('sku_prefix', prefix)
    .single()
  if (error) throw new Error(`readCounter(${prefix}): ${error.message}`)
  return (data as { last_number: number }).last_number
}

/** Restores a counter so a test run leaves the seed state as it found it. */
export async function setCounter(prefix: string, value: number): Promise<void> {
  const { error } = await serviceClient()
    .from('sku_counters')
    .update({ last_number: value })
    .eq('sku_prefix', prefix)
  if (error) throw new Error(`setCounter(${prefix}, ${value}): ${error.message}`)
}

/**
 * Largest number of calls whose execution windows overlapped at the same instant.
 * Guards against a false pass where 100 calls ran one after another and trivially
 * produced 100 consecutive integers without ever contending for the row lock.
 */
export function maxOverlap(outcomes: readonly RpcOutcome[]): number {
  const points = outcomes
    .flatMap((o) => [
      { t: o.startedAt, d: 1 },
      { t: o.finishedAt, d: -1 },
    ])
    .sort((a, b) => a.t - b.t || a.d - b.d)

  let current = 0
  let peak = 0
  for (const p of points) {
    current += p.d
    peak = Math.max(peak, current)
  }
  return peak
}
