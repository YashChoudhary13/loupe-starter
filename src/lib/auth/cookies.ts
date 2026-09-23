import 'server-only'

import { FACE_DOMAIN } from '@/lib/faces/faces'
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

/** One sign-in for four hosts (D136): in production the cookies belong to `.qimati-eng.site`. Dev (http, localhost) and any base outside that domain keep host-only cookies. */
export function cookieDomain(): string | undefined {
  if (!secureCookies()) return undefined
  const host = new URL(serverEnv.authBaseUrl).hostname
  return host === FACE_DOMAIN || host.endsWith(`.${FACE_DOMAIN}`) ? `.${FACE_DOMAIN}` : undefined
}

function base() {
  const domain = cookieDomain()
  return { httpOnly: true, secure: secureCookies(), sameSite: 'lax' as const, path: '/', ...(domain ? { domain } : {}) }
}

export function sessionCookieOptions() { return { ...base(), maxAge: SESSION_TTL_SECONDS } }

/** The handshake and denial cookies exist for one redirect and then go away. */
export function shortLivedCookieOptions(maxAgeSeconds: number) { return { ...base(), maxAge: maxAgeSeconds } }

export function clearedCookieOptions() { return { ...base(), maxAge: 0 } }

/** A raw `Set-Cookie` that clears the pre-platform host-only cookie of the same name — a domain cookie cannot reach it, and `ResponseCookies` keeps one entry per name. */
export function clearHostOnlyCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookies() ? '; Secure' : ''}`
}
