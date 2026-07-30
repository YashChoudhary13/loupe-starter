import 'server-only'

import { serverEnv } from '@/lib/env'

import { SESSION_TTL_SECONDS } from './session'

/**
 * Cookie flags, in one place so no route can forget one.
 *
 * `sameSite: 'lax'` rather than `strict` because the OAuth callback is a
 * top-level GET arriving from accounts.google.com — `strict` would withhold the
 * handshake cookie at exactly the moment it is needed, and sign-in would fail
 * with a state mismatch that looks like an attack rather than a config mistake.
 * `lax` still withholds the session on cross-site POSTs, which is the case that
 * matters for a server action.
 */
export function secureCookies(): boolean {
  return serverEnv.authBaseUrl.startsWith('https://')
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  }
}

/** The handshake and denial cookies exist for one redirect and then go away. */
export function shortLivedCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

export function clearedCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  }
}
