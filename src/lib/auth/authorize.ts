import 'server-only'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

import type { GoogleOAuthConfig } from './google'
import { readSession, SESSION_COOKIE, type SessionPayload } from './session'

/**
 * Who is allowed in, decided on the server, on every request.
 *
 * Two gates, and they are different things:
 *
 *   1. the signed cookie says which `app_users` row signed in;
 *   2. that row is READ BACK from the database and must still be active.
 *
 * The second gate is the one that matters. Trusting the cookie's own `role` and
 * `email` would mean a deactivated operator keeps working until their session
 * happens to expire, and it would make the cookie an authority rather than a
 * claim. `app_users` is the authorisation rule (CLAUDE.md), so `app_users` is
 * what gets asked.
 *
 * Note there is no `ALLOWED_EMAIL_DOMAIN` check anywhere. That is deliberate and
 * documented: the only admin is a gmail.com address, and a domain check would
 * lock them out.
 */

export interface Operator {
  readonly id: string
  readonly email: string
  readonly name: string | null
  readonly role: 'admin' | 'operator'
}

/** What the audit trail records as `events.actor` — never a browser-supplied name. */
export function actorFor(operator: Operator): string {
  return operator.email
}

export function googleOAuthConfig(): GoogleOAuthConfig {
  return {
    clientId: serverEnv.googleOAuthClientId,
    clientSecret: serverEnv.googleOAuthClientSecret,
    redirectUri: `${serverEnv.authBaseUrl}/api/auth/google/callback`,
  }
}

interface AppUserRow {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'operator'
  active: boolean
}

/**
 * The allowlist lookup. Exact email match on an active row — not a domain, not a
 * prefix, not a pattern.
 */
export async function findActiveAppUser(email: string): Promise<Operator | null> {
  const normalised = email.trim().toLowerCase()
  if (!normalised) return null

  const { data, error } = await supabaseServer()
    .from('app_users')
    .select('id, email, name, role, active')
    .eq('email', normalised)
    .eq('active', true)
    .maybeSingle<AppUserRow>()

  if (error) throw new Error(`app_users lookup failed: ${error.message}`)
  if (!data) return null
  return { id: data.id, email: data.email, name: data.name, role: data.role }
}

export async function findActiveAppUserById(id: string): Promise<Operator | null> {
  const { data, error } = await supabaseServer()
    .from('app_users')
    .select('id, email, name, role, active')
    .eq('id', id)
    .eq('active', true)
    .maybeSingle<AppUserRow>()

  if (error) throw new Error(`app_users lookup failed: ${error.message}`)
  if (!data) return null
  return { id: data.id, email: data.email, name: data.name, role: data.role }
}

export async function touchLastSeen(id: string): Promise<void> {
  const { error } = await supabaseServer()
    .from('app_users')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', id)
  // Best effort: a failed timestamp must not cost somebody their session.
  if (error) console.warn(`app_users.last_seen_at not updated for ${id}: ${error.message}`)
}

export function sessionFromCookie(raw: string | undefined): SessionPayload | null {
  return readSession(serverEnv.authSessionSecret, raw)
}

/** The signed-in operator, or null. Never throws on a bad cookie — that is a sign-out. */
export async function currentOperator(): Promise<Operator | null> {
  const jar = await cookies()
  const session = sessionFromCookie(jar.get(SESSION_COOKIE)?.value)
  if (!session) return null
  return findActiveAppUserById(session.uid)
}

/** For pages. Sends an unauthenticated visitor to the sign-in screen. */
export async function requireOperator(): Promise<Operator> {
  const operator = await currentOperator()
  if (!operator) redirect('/login')
  return operator
}

export class NotAuthorisedError extends Error {
  constructor() {
    super('Your session has ended. Sign in again to continue.')
    this.name = 'NotAuthorisedError'
  }
}

/**
 * For server actions and route handlers.
 *
 * Every mutation calls this. A server action is a public POST endpoint with a
 * generated name — it is not protected by the page that renders its button, so
 * "the console checked already" is not a check.
 */
export async function requireOperatorForAction(): Promise<Operator> {
  const operator = await currentOperator()
  if (!operator) throw new NotAuthorisedError()
  return operator
}
