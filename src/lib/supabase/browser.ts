import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The browser client. Uses the PUBLISHABLE key (sb_publishable_…), not the
 * legacy anon JWT.
 *
 * This key is safe to ship because it is subject to Row Level Security, and
 * every table in this schema has RLS enabled with zero policies. As of Phase 1
 * that means this client can read and write NOTHING — which is correct. Phase 4
 * adds sign-in; if a screen then genuinely needs direct browser reads, that
 * phase adds a narrow policy and says why.
 *
 * There is deliberately no service_role path in this file and no import of
 * @/lib/env — this module must stay safe to pull into a 'use client' component.
 */
let cached: SupabaseClient | undefined

export function supabaseBrowser(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (!url || !publishableKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. ' +
        'Both must be present at build time — Next.js inlines NEXT_PUBLIC_* values.',
    )
  }

  if (!publishableKey.startsWith('sb_publishable_')) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY does not look like a publishable key. ' +
        'Expected sb_publishable_… — not the legacy anon JWT, and certainly not the service_role key.',
    )
  }

  cached ??= createClient(url, publishableKey, {
    global: { headers: { 'x-loupe-client': 'browser' } },
  })
  return cached
}
