/**
 * Phase 4 · criteria 1 and 2 — the parts of sign-in that can be proved without a
 * browser.
 *
 * The session cookie is the whole reason an unauthorised person cannot reach the
 * console, so what matters is not that a valid cookie is accepted — it is that
 * every INVALID one is refused: tampered payload, foreign signature, wrong
 * secret, expired, truncated, missing. Those are asserted individually here
 * because "it works when I sign in" proves none of them.
 */
import { describe, expect, it } from 'vitest'

import {
  authorizationUrl,
  exchangeCodeForIdentity,
  GoogleAuthError,
  pkceChallenge,
  readIdentity,
} from '@/lib/auth/google'
import {
  decodeSignedValue,
  encodeSignedValue,
  issueSession,
  randomToken,
  readSession,
  SESSION_TTL_SECONDS,
  validatedSessionSecret,
} from '@/lib/auth/session'

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)
const USER = { id: 'user-1', email: 'operator@example.com', name: 'Op', role: 'operator' }

const OAUTH = {
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-not-a-real-secret',
  redirectUri: 'https://loupe.example.com/api/auth/google/callback',
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`
}

const VALID_CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: OAUTH.clientId,
  exp: 2_000_000_000,
  email: 'Operator@Example.com',
  email_verified: true,
  name: 'Op',
  sub: 'google-sub-1',
}

describe('AUTH_SESSION_SECRET', () => {
  it('demands 32 random bytes as hex, not a memorable password', () => {
    expect(validatedSessionSecret(SECRET)).toBe(SECRET)
    expect(() => validatedSessionSecret('hunter2')).toThrow(/64 hex/)
    expect(() => validatedSessionSecret(undefined)).toThrow(/64 hex/)
    expect(() => validatedSessionSecret('a'.repeat(63))).toThrow(/64 hex/)
  })
})

describe('the session cookie', () => {
  it('round-trips the app_users identity and an expiry', () => {
    const { value, payload } = issueSession(SECRET, USER, 1_000)
    expect(payload.uid).toBe('user-1')
    expect(payload.exp).toBe(1_000 + SESSION_TTL_SECONDS)

    const read = readSession(SECRET, value, 1_000)
    expect(read?.uid).toBe('user-1')
    expect(read?.email).toBe('operator@example.com')
  })

  it('refuses a payload edited in the browser', () => {
    const { value } = issueSession(SECRET, USER, 1_000)
    const [body, signature] = value.split('.')

    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      uid: string
      role: string
    }
    forged.uid = 'somebody-else'
    forged.role = 'admin'
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`

    expect(readSession(SECRET, tampered, 1_000)).toBeNull()
  })

  it('refuses a cookie signed with a different secret — rotation signs everyone out', () => {
    const { value } = issueSession(OTHER_SECRET, USER, 1_000)
    expect(readSession(SECRET, value, 1_000)).toBeNull()
  })

  it('refuses an expired cookie, to the second', () => {
    const { value, payload } = issueSession(SECRET, USER, 1_000)
    expect(readSession(SECRET, value, payload.exp - 1)).not.toBeNull()
    expect(readSession(SECRET, value, payload.exp)).toBeNull()
    expect(readSession(SECRET, value, payload.exp + 1)).toBeNull()
  })

  it('refuses malformed values rather than throwing on them', () => {
    for (const value of ['', 'not-a-cookie', 'a.b.c', '.sig', 'body.', undefined, null]) {
      expect(readSession(SECRET, value as string | undefined, 1_000)).toBeNull()
    }
  })

  it('refuses a correctly signed value that is not a session', () => {
    // The handshake cookie is signed with the same secret. It must not be
    // accepted as a session just because the signature checks out.
    const handshake = encodeSignedValue(SECRET, { state: 'x', codeVerifier: 'y' })
    expect(readSession(SECRET, handshake, 1_000)).toBeNull()
  })

  it('signs and reads the handshake cookie', () => {
    const value = encodeSignedValue(SECRET, { state: 's', codeVerifier: 'v' })
    expect(decodeSignedValue<{ state: string }>(SECRET, value)?.state).toBe('s')
    expect(decodeSignedValue(OTHER_SECRET, value)).toBeNull()
  })

  it('generates distinct high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()))
    expect(tokens.size).toBe(200)
    expect([...tokens][0].length).toBeGreaterThanOrEqual(40)
  })
})

describe('the Google authorization redirect', () => {
  it('sends PKCE S256, state, and always offers the account chooser', () => {
    const url = new URL(authorizationUrl(OAUTH, { state: 'STATE', codeVerifier: 'VERIFIER' }))

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(OAUTH.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge('VERIFIER'))
    // Without this, testing a REFUSED account is impossible: Google silently
    // reuses whichever account the browser last signed in with.
    expect(url.searchParams.get('prompt')).toBe('select_account')
    // The verifier itself must never travel with the redirect.
    expect(url.toString()).not.toContain('VERIFIER')
    // Nor may the secret.
    expect(url.toString()).not.toContain(OAUTH.clientSecret)
  })
})

describe('reading a Google identity', () => {
  it('accepts a well-formed token and normalises the email', () => {
    const identity = readIdentity(idToken(VALID_CLAIMS), OAUTH, 1_000)
    // Lowercased, because `app_users.email` is lowercased by trigger and the
    // lookup is an exact match.
    expect(identity.email).toBe('operator@example.com')
    expect(identity.name).toBe('Op')
    expect(identity.subject).toBe('google-sub-1')
  })

  it.each([
    ['a token from somewhere else', { ...VALID_CLAIMS, iss: 'https://evil.example.com' }],
    ['a token for another application', { ...VALID_CLAIMS, aud: 'other-client' }],
    ['an expired token', { ...VALID_CLAIMS, exp: 999 }],
    ['a token with no email', { ...VALID_CLAIMS, email: '' }],
    ['an unverified email', { ...VALID_CLAIMS, email_verified: false }],
  ])('refuses %s', (_label, claims) => {
    expect(() => readIdentity(idToken(claims), OAUTH, 1_000)).toThrow(GoogleAuthError)
  })

  it('refuses something that is not a JWT at all', () => {
    expect(() => readIdentity('nonsense', OAUTH, 1_000)).toThrow(GoogleAuthError)
    expect(() => readIdentity('a.!!!.c', OAUTH, 1_000)).toThrow(GoogleAuthError)
  })
})

describe('the code exchange', () => {
  it('posts the code, the verifier and the secret to Google, and nothing else', async () => {
    let seen: { url: string; body: URLSearchParams } | null = null
    const identity = await exchangeCodeForIdentity(
      OAUTH,
      { code: 'CODE', codeVerifier: 'VERIFIER' },
      {
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen = { url: String(url), body: new URLSearchParams(String(init.body)) }
          return new Response(JSON.stringify({ id_token: idToken(VALID_CLAIMS) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }) as unknown as typeof fetch,
      },
    )

    expect(identity.email).toBe('operator@example.com')
    expect(seen!.url).toBe('https://oauth2.googleapis.com/token')
    expect(seen!.body.get('grant_type')).toBe('authorization_code')
    expect(seen!.body.get('code')).toBe('CODE')
    expect(seen!.body.get('code_verifier')).toBe('VERIFIER')
    expect(seen!.body.get('client_secret')).toBe(OAUTH.clientSecret)
  })

  it('turns a refusal into an operator sentence that leaks no response body', async () => {
    const error = await exchangeCodeForIdentity(
      OAUTH,
      { code: 'CODE', codeVerifier: 'VERIFIER' },
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: 'invalid_grant', code: 'CODE' }), {
            status: 400,
          })) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e as GoogleAuthError)

    expect(error).toBeInstanceOf(GoogleAuthError)
    expect((error as GoogleAuthError).operatorMessage).toMatch(/Google refused/)
    expect((error as GoogleAuthError).operatorMessage).not.toContain('CODE')
    expect((error as GoogleAuthError).operatorMessage).not.toContain('invalid_grant')
  })

  it('refuses a 200 that carries no identity', async () => {
    await expect(
      exchangeCodeForIdentity(
        OAUTH,
        { code: 'CODE', codeVerifier: 'V' },
        {
          fetchImpl: (async () =>
            new Response(JSON.stringify({ access_token: 'x' }), { status: 200 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(GoogleAuthError)
  })
})
