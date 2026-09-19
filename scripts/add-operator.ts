/**
 * Allow one more person to sign in to Loupe (membership of app_users is the rule, CLAUDE.md hard rule 7).
 *
 *   npx tsx scripts/add-operator.ts <env-file> <email> [operator|admin]
 *
 * Idempotent upsert: an existing row is re-activated and its role set; nothing is deleted.
 * Records an `events` row like seed-admin. No .env is read implicitly: the env file is explicit.
 */
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

async function main(): Promise<void> {
  const [envFile, rawEmail, rawRole = 'operator'] = process.argv.slice(2)
  if (!envFile || !rawEmail) throw new Error('Usage: <env-file> <email> [operator|admin]')
  const email = rawEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Give a full email address.')
  if (rawRole !== 'operator' && rawRole !== 'admin') throw new Error('Role must be operator or admin.')
  const env = parse(readFileSync(envFile))
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('Env file needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const before = await db.from('app_users').select('id, role, active').eq('email', email).maybeSingle()
  if (before.error) throw new Error(`Lookup failed: ${before.error.message}`)
  const { data, error } = await db.from('app_users').upsert({ email, role: rawRole, active: true }, { onConflict: 'email' }).select('id, email, role, active, created_at').single()
  if (error) throw new Error(`Failed to add operator: ${error.message}`)
  await db.from('events').insert({ entity_type: 'app_user', entity_id: data.id, event: before.data ? 'user.updated' : 'user.added', detail: { email, role: rawRole, previous: before.data ?? null }, actor: 'script:add-operator' })
  console.log(JSON.stringify({ ...data, previous: before.data ?? null, projectHost: new URL(url).host }, null, 2))
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
