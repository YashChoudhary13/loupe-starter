import 'server-only'

import { validatedSessionSecret } from '@/lib/auth/session'
import { validatedCronSecret } from '@/lib/cron/secret'

/**
 * Server-side environment access.
 *
 * `import 'server-only'` is the first line on purpose: if any client component
 * ever reaches this module — directly or through a transitive import — the build
 * fails with a hard error instead of quietly shipping a secret to the browser.
 * CLAUDE.md hard rule 7.
 *
 * Client-safe values are NOT read through here. They are read from
 * process.env.NEXT_PUBLIC_* at their point of use so Next.js can inline them.
 */

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Copy .env.local.example to .env.local and fill it in.`,
    )
  }
  return value
}

export const serverEnv = {
  /** Supabase REST endpoint. Not a secret, but read here for a single source of truth. */
  get supabaseUrl(): string {
    return required('NEXT_PUBLIC_SUPABASE_URL')
  },

  /**
   * Full-access key. Bypasses Row Level Security. Never log it, never return it
   * from a route handler, never put it in a prop.
   */
  get supabaseServiceRoleKey(): string {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },

  /** The one flat Google Drive folder watched as Loupe's photo inbox. */
  get driveRawFolderId(): string {
    return required('DRIVE_RAW_FOLDER_ID')
  },

  /**
   * Where published source photographs are tidied away to. HOUSEKEEPING ONLY —
   * nothing reads Drive folder membership to decide what has been processed
   * (hard rule 3), so a wrong value here leaves an untidy Raw folder, not a
   * broken pipeline.
   */
  get driveProcessedFolderId(): string {
    return required('DRIVE_PROCESSED_FOLDER_ID')
  },

  /** Shared secret accepted by server-side cron routes. */
  get cronSecret(): string {
    return validatedCronSecret(process.env.CRON_SECRET)
  },

  /** Stable deployed origin used when provisioning external cron callers. */
  get cronBaseUrl(): string {
    return required('CRON_BASE_URL')
  },

  /** One billing route for both the describer and image generator. */
  get openRouterApiKey(): string {
    return required('OPENROUTER_API_KEY')
  },

  /** Private Cloudflare R2 S3-compatible endpoint and credentials. */
  get r2Endpoint(): string {
    return required('R2_ENDPOINT')
  },
  get r2AccessKeyId(): string {
    return required('R2_ACCESS_KEY_ID')
  },
  get r2SecretAccessKey(): string {
    return required('R2_SECRET_ACCESS_KEY')
  },
  get r2Bucket(): string {
    return required('R2_BUCKET')
  },

  /**
   * Google sign-in (Phase 4). The secret is exchanged server-to-server for an ID
   * token; nothing here is ever inlined into a client bundle, and
   * `npm run verify:isolation` proves it.
   */
  get googleOAuthClientId(): string {
    return required('GOOGLE_OAUTH_CLIENT_ID')
  },
  get googleOAuthClientSecret(): string {
    return required('GOOGLE_OAUTH_CLIENT_SECRET')
  },

  /** Signs the console session cookie. 32 random bytes as 64 hex characters. */
  get authSessionSecret(): string {
    return validatedSessionSecret(process.env.AUTH_SESSION_SECRET)
  },

  /**
   * The origin the console is actually served from, without a trailing slash.
   *
   * Configured, never derived from the request's Host header. The redirect URI
   * has to match what is registered on the OAuth client exactly, so guessing it
   * from a header both breaks sign-in on a proxy and turns a forged Host into a
   * way to point the redirect somewhere else.
   */
  get authBaseUrl(): string {
    return required('AUTH_BASE_URL').replace(/\/+$/, '')
  },
} as const
