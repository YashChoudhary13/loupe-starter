import 'server-only'

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
} as const
