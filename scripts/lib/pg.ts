import { config } from 'dotenv'
import { Client, Pool, type PoolConfig } from 'pg'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

/**
 * A direct Postgres connection, for things PostgREST cannot do: DDL, and holding
 * a transaction open across statements (which the concurrency proof needs).
 *
 * Supabase's direct host `db.<ref>.supabase.co` resolves to IPv6 only, so the
 * default is the IPv4 session pooler. Note the region shard is `aws-1` for this
 * project — `aws-0-ap-south-1` returns "tenant not found".
 *
 * Requires SUPABASE_DB_PASSWORD. That is a DIFFERENT credential from
 * SUPABASE_SERVICE_ROLE_KEY: the service-role key is a JWT for the PostgREST API
 * and cannot authenticate a Postgres wire connection.
 */
export function pgConfig(): PoolConfig {
  const ref = requireEnv('SUPABASE_PROJECT_REF')
  const password = requireEnv('SUPABASE_DB_PASSWORD')
  const host = process.env.SUPABASE_DB_HOST ?? `aws-1-${process.env.SUPABASE_REGION ?? 'ap-south-1'}.pooler.supabase.com`

  return {
    host,
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    user: `postgres.${ref}`,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  }
}

export function pgClient(): Client {
  return new Client(pgConfig())
}

export function pgPool(max: number): Pool {
  return new Pool({ ...pgConfig(), max })
}

function requireEnv(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) {
    throw new Error(
      `${key} is missing from .env.\n` +
        `Supabase Dashboard → Project Settings → Database → Database password.`,
    )
  }
  return v
}

/** True when the wire connection works and the password is current. */
export async function canConnect(): Promise<{ ok: true } | { ok: false; reason: string }> {
  let client: Client
  try {
    client = pgClient()
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  try {
    await client.connect()
    await client.query('select 1')
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    const hint =
      err.code === '28P01'
        ? ' — SUPABASE_DB_PASSWORD is wrong or stale. Reset it in the Supabase dashboard.'
        : ''
    return { ok: false, reason: `${err.code ?? ''} ${err.message ?? String(e)}${hint}` }
  } finally {
    await client.end().catch(() => {})
  }
}
