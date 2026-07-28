import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { serverEnv } from '@/lib/env'

/**
 * The privileged Supabase client. Uses the service_role key, so it BYPASSES Row
 * Level Security — which is the whole design: every table has RLS enabled with
 * zero policies, so this client can do everything and the browser client can do
 * nothing (supabase/migrations/20260728121000_rls_deny_all.sql).
 *
 * `import 'server-only'` above makes that structural rather than a convention.
 * A client component that imports this module — at any depth — fails the build.
 * See tests/service-role-isolation.test.ts, which proves it by trying.
 *
 * Never import this from a file carrying 'use client'.
 */
let cached: SupabaseClient | undefined

export function supabaseServer(): SupabaseClient {
  cached ??= createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: {
      // No user session on the server: this key is the authority, and persisting
      // or refreshing anything would only create a way to leak it.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-loupe-client': 'server' },
    },
  })
  return cached
}
