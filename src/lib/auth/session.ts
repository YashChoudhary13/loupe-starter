import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The console session cookie.
 *
 * A signed value rather than a session table, and deliberately not a Supabase
 * Auth JWT. The cookie proves ONE thing — which `app_users` row signed in — and
 * every protected surface re-reads that row from the database before doing
 * anything (src/lib/auth/authorize.ts). So the cookie is a claim of identity,
 * never a grant of authority: deactivating a user takes effect on their next
 * request rather than whenever their token happens to expire.
 *
 * That is also why there is no role check anywhere against the cookie's `role`.
 * It is carried for display and for the audit actor only; the authoritative role
 * comes back with the row.
 *
 * HMAC-SHA256 over the exact encoded payload bytes, compared in constant time.
 * No encryption: nothing in here is secret — an operator's own email and id — and
 * an encrypted cookie that nobody can inspect is harder to debug for no gain.
 */

/** 12 hours. Long enough for a full batch session, short enough to matter. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60

export const SESSION_COOKIE = 'loupe_session'
/** Carries the OAuth `state` and PKCE verifier between the two redirects. */
export const OAUTH_COOKIE = 'loupe_oauth'
/** Carries a refused sign-in to the access-denied screen without a query string. */
export const DENIED_COOKIE = 'loupe_denied'

const SECURE_SESSION_SECRET = /^[A-Fa-f0-9]{64}$/

export interface SessionPayload {
  /** `app_users.id`. The only field that identifies anything. */
  readonly uid: string
  readonly email: string
  readonly name: string | null
  readonly role: string
  /** Seconds since the epoch. */
  readonly iat: number
  readonly exp: number
}

export function validatedSessionSecret(raw: string | undefined | null): string {
  const value = raw?.trim() ?? ''
  if (!SECURE_SESSION_SECRET.test(value)) {
    throw new Error(
      'AUTH_SESSION_SECRET must be exactly 32 random bytes encoded as 64 hex characters. ' +
        'Generate one with: openssl rand -hex 32',
    )
  }
  return value
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('base64url')
}

/**
 * Constant-time comparison that also survives a length mismatch — `timingSafeEqual`
 * throws on different lengths, and throwing is itself an oracle.
 */
function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function encodeSignedValue(secret: string, payload: unknown): string {
  const body = b64url(JSON.stringify(payload))
  return `${body}.${sign(secret, body)}`
}

export function decodeSignedValue<T>(secret: string, token: string | undefined | null): T | null {
  if (!token) return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null

  const body = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!signatureMatches(sign(secret, body), signature)) return null

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export function issueSession(
  secret: string,
  user: { id: string; email: string; name: string | null; role: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { value: string; payload: SessionPayload } {
  const payload: SessionPayload = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  }
  return { value: encodeSignedValue(secret, payload), payload }
}

export function readSession(
  secret: string,
  token: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  const payload = decodeSignedValue<SessionPayload>(secret, token)
  if (!payload) return null
  if (
    typeof payload.uid !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  if (payload.exp <= nowSeconds) return null
  return payload
}

/** 128 bits of `state` / PKCE verifier entropy, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
