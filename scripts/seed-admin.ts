/**
 * Seeds the first admin into app_users from SEED_ADMIN_EMAIL.
 *
 *   npm run seed:admin
 *
 * Deliberately a script and not a migration. Categories and materials are domain
 * facts that belong in git and are identical everywhere; who may sign in is
 * environment-specific identity that must not be baked into a migration which
 * will later run against staging and production. See docs/DECISIONS.md D13.
 *
 * Idempotent: re-running promotes the same address rather than erroring.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config({ path: '.env', quiet: true })
config({ path: '.env.local', override: true, quiet: true })

function required(key: string): string {
  const v = process.env[key]?.trim()
  if (!v) throw new Error(`Missing ${key} in .env`)
  return v
}

async function main(): Promise<void> {
  const email = required('SEED_ADMIN_EMAIL').toLowerCase()
  const db = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data, error } = await db
    .from('app_users')
    .upsert({ email, role: 'admin', active: true }, { onConflict: 'email' })
    .select('id, email, role, active, created_at')
    .single()

  if (error) throw new Error(`Failed to seed admin: ${error.message}`)

  await db.from('events').insert({
    entity_type: 'app_user',
    entity_id: data.id,
    event: 'seed.admin',
    detail: { email: data.email, role: data.role },
    actor: 'script:seed-admin',
  })

  console.log('Seeded admin:', data)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
