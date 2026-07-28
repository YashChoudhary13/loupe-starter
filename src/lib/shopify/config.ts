/**
 * Shopify configuration, read from the environment.
 *
 * NOTE ON `server-only`: this module deliberately does NOT `import 'server-only'`,
 * unlike `src/lib/env.ts`. It has to be importable from `scripts/` and from vitest,
 * both of which run in plain Node where the `server-only` shim throws. The Phase 1
 * scripts sidestepped this the same way, by declaring their own `required()`.
 *
 * Hard rule 7 is still enforced, structurally, in two places:
 *   1. Next.js never inlines a non-`NEXT_PUBLIC_` variable into a client bundle —
 *      `process.env.SHOPIFY_CLIENT_SECRET` in a client component is `undefined`,
 *      not the value.
 *   2. `npm run verify:isolation` scans the built client assets for the Shopify
 *      client secret as well as the Supabase service-role key, against a control
 *      that proves the scan can see values which really do ship.
 */

/**
 * Pinned so a Shopify release cannot change the shape of our requests overnight.
 * Override with SHOPIFY_API_VERSION. Shopify supports each version for 12 months;
 * bumping this is a deliberate act with a re-run of `npm run verify:publish`.
 */
export const DEFAULT_SHOPIFY_API_VERSION = '2026-07'

export interface ShopifyConfig {
  /** `<store>.myshopify.com`. The test store is `qimti` — no second "a". */
  readonly storeDomain: string
  readonly clientId: string
  readonly clientSecret: string
  readonly apiVersion: string
}

export type EnvLike = Record<string, string | undefined>

function required(env: EnvLike, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Shopify auth is the client_credentials grant — see .env.local.example.`,
    )
  }
  return value
}

export function shopifyConfig(env: EnvLike = process.env): ShopifyConfig {
  const storeDomain = required(env, 'SHOPIFY_STORE_DOMAIN')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')

  if (!storeDomain.endsWith('.myshopify.com')) {
    throw new Error(
      `SHOPIFY_STORE_DOMAIN must be the <store>.myshopify.com admin domain, got "${storeDomain}". ` +
        `The public domain (qimati.in) is not an Admin API host.`,
    )
  }

  const authMode = env.SHOPIFY_AUTH_MODE?.trim()
  if (authMode && authMode !== 'client_credentials') {
    throw new Error(
      `SHOPIFY_AUTH_MODE is "${authMode}". Loupe only implements the client_credentials grant ` +
        `(CLAUDE.md hard rule 7). A static shpat_ token is not supported.`,
    )
  }

  return {
    storeDomain,
    clientId: required(env, 'SHOPIFY_CLIENT_ID'),
    clientSecret: required(env, 'SHOPIFY_CLIENT_SECRET'),
    apiVersion: env.SHOPIFY_API_VERSION?.trim() || DEFAULT_SHOPIFY_API_VERSION,
  }
}

export function tokenEndpoint(config: ShopifyConfig): string {
  return `https://${config.storeDomain}/admin/oauth/access_token`
}

export function graphqlEndpoint(config: ShopifyConfig): string {
  return `https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`
}
