/**
 * Adds the narrow browser permission needed by "Upload ready image".
 *
 *   npm run r2:cors
 *   npm run r2:cors -- --origin https://qimati-loupe.vercel.app
 *
 * This does not make the bucket public. It only allows PUT/HEAD requests from
 * the configured console origin; every object write still needs a short-lived
 * signed URL minted by the authenticated server action.
 */
import { config } from 'dotenv'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

const RULE_ID = 'loupe-manual-ready-upload'

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing ${key}.`)
  return value
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1]?.trim() || null) : null
}

function accountId(): string {
  const configured = process.env.R2_ACCOUNT_ID?.trim()
  if (configured) return configured
  const endpoint = new URL(required('R2_ENDPOINT'))
  const derived = endpoint.hostname.split('.')[0]?.trim()
  if (!derived) throw new Error('R2_ACCOUNT_ID is missing and could not be derived from R2_ENDPOINT.')
  return derived
}

interface CorsRule {
  readonly id?: string
  readonly allowed: {
    readonly origins: readonly string[]
    readonly methods: readonly string[]
    readonly headers?: readonly string[]
  }
  readonly exposeHeaders?: readonly string[]
  readonly maxAgeSeconds?: number
}

interface CloudflareEnvelope<T> {
  readonly success: boolean
  readonly result: T
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[]
}

async function cloudflare<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${required('R2_API_TOKEN')}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const body = (await response.json()) as CloudflareEnvelope<T>
  if (!response.ok || !body.success) {
    const detail = body.errors?.map((error) => error.message ?? error.code).join('; ')
    throw new Error(`Cloudflare CORS API returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`)
  }
  return body.result
}

async function main(): Promise<void> {
  const origin = (argument('--origin') ?? required('AUTH_BASE_URL')).replace(/\/+$/, '')
  const base =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId())}` +
    `/r2/buckets/${encodeURIComponent(required('R2_BUCKET'))}/cors`

  const current = await cloudflare<{ rules?: readonly CorsRule[] }>(base, { method: 'GET' })
  const rule: CorsRule = {
    id: RULE_ID,
    allowed: {
      origins: [origin],
      methods: ['PUT', 'HEAD'],
      headers: ['Content-Type'],
    },
    exposeHeaders: ['ETag'],
    maxAgeSeconds: 3_600,
  }
  const rules = [...(current.rules ?? []).filter((candidate) => candidate.id !== RULE_ID), rule]

  await cloudflare(base, { method: 'PUT', body: JSON.stringify({ rules }) })
  const verified = await cloudflare<{ rules?: readonly CorsRule[] }>(base, { method: 'GET' })
  const installed = verified.rules?.find((candidate) => candidate.id === RULE_ID)
  if (!installed || JSON.stringify(installed.allowed) !== JSON.stringify(rule.allowed)) {
    throw new Error('Cloudflare accepted the change, but the expected CORS rule was not read back.')
  }

  console.log(`R2 browser upload enabled for ${origin}. The bucket remains private.`)
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})
