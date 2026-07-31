/**
 * Stores the public Loupe URL and the shared cron secret in Supabase Vault,
 * then creates/updates the Drive intake and enhancement pg_cron jobs.
 *
 * Secrets are parameters to Vault functions. They are never interpolated into
 * migration SQL, cron.job.command, logs, or this file.
 *
 *   npm run cron:configure
 */
import { pgClient } from './lib/pg'
import { validatedCronSecret } from '../src/lib/cron/secret'

const VAULT_BASE_URL = 'loupe_cron_base_url'
const VAULT_SECRET = 'loupe_cron_secret'

interface CronJob {
  readonly name: string
  readonly schedule: string
  readonly path: `/api/cron/${string}`
  readonly timeoutMilliseconds: number
}

const JOBS: readonly CronJob[] = [
  {
    name: 'loupe-drive-watch',
    schedule: '* * * * *',
    path: '/api/cron/watch',
    timeoutMilliseconds: 30_000,
  },
  {
    name: 'loupe-drive-reconcile',
    schedule: '*/15 * * * *',
    path: '/api/cron/reconcile',
    timeoutMilliseconds: 30_000,
  },
  {
    name: 'loupe-intake-sweep',
    schedule: '*/5 * * * *',
    path: '/api/cron/sweep',
    timeoutMilliseconds: 30_000,
  },
  {
    name: 'loupe-image-enhance',
    schedule: '* * * * *',
    path: '/api/cron/enhance',
    timeoutMilliseconds: 285_000,
  },
  {
    // 03:00 Asia/Kolkata. pg_cron schedules are UTC.
    name: 'loupe-shopify-reconcile',
    schedule: '30 21 * * *',
    path: '/api/cron/shopify-reconcile',
    timeoutMilliseconds: 285_000,
  },
]

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is missing from .env`)
  return value
}

function productionBaseUrl(): string {
  const raw = required('CRON_BASE_URL')
  const url = new URL(raw)
  if (url.protocol !== 'https:') {
    throw new Error('CRON_BASE_URL must use https:// because pg_net calls it over the public internet')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CRON_BASE_URL must be a plain origin with no credentials, query, or fragment')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

async function upsertVaultSecret(
  client: ReturnType<typeof pgClient>,
  name: string,
  value: string,
  description: string,
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    'select id from vault.secrets where name = $1 limit 1',
    [name],
  )

  if (existing.rowCount && existing.rows[0]) {
    await client.query('select vault.update_secret($1::uuid, $2, $3, $4)', [
      existing.rows[0].id,
      value,
      name,
      description,
    ])
    return
  }

  await client.query('select vault.create_secret($1, $2, $3)', [value, name, description])
}

function commandFor(job: CronJob): string {
  // Every value is selected from the constant JOBS table above, never user input.
  return `
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = '${VAULT_BASE_URL}'
        limit 1
      ) || '${job.path}',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = '${VAULT_SECRET}'
          limit 1
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-pg-cron',
        'requested_at', now()
      ),
      timeout_milliseconds := ${job.timeoutMilliseconds}
    ) as request_id;
  `
}

async function main(): Promise<void> {
  const baseUrl = productionBaseUrl()
  const secret = validatedCronSecret(process.env.CRON_SECRET)
  const client = pgClient()
  await client.connect()

  try {
    const extensions = await client.query<{ extname: string }>(
      `select extname from pg_extension where extname in ('pg_cron', 'pg_net', 'supabase_vault')`,
    )
    const installed = new Set(extensions.rows.map((row) => row.extname))
    for (const requiredExtension of ['pg_cron', 'pg_net', 'supabase_vault']) {
      if (!installed.has(requiredExtension)) {
        throw new Error(
          `${requiredExtension} is not installed. Run the Phase 3A migration first; ` +
            `do not create cron jobs around a missing extension.`,
        )
      }
    }

    await client.query('begin')
    try {
      await upsertVaultSecret(
        client,
        VAULT_BASE_URL,
        baseUrl,
        'Stable production origin used by Loupe pg_cron jobs.',
      )
      await upsertVaultSecret(
        client,
        VAULT_SECRET,
        secret,
        'Shared bearer secret for Loupe POST /api/cron/* routes.',
      )

      for (const job of JOBS) {
        await client.query('select cron.schedule($1, $2, $3)', [
          job.name,
          job.schedule,
          commandFor(job),
        ])
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    }

    const configured = await client.query<{
      jobid: number
      jobname: string
      schedule: string
      active: boolean
    }>(
      `select jobid, jobname, schedule, active
         from cron.job
        where jobname = any($1::text[])
        order by jobname`,
      [JOBS.map((job) => job.name)],
    )

    console.log(`Cron target: ${baseUrl}`)
    console.table(configured.rows)
    if (configured.rows.length !== JOBS.length || configured.rows.some((job) => !job.active)) {
      throw new Error(`Expected ${JOBS.length} active Loupe jobs, found ${configured.rows.length}`)
    }
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(`\ncron:configure failed\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
