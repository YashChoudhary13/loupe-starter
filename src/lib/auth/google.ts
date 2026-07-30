import { createHash } from 'node:crypto'

/**
 * Google sign-in — the OAuth 2.0 authorization-code flow with PKCE, done
 * server-side.
 *
 * WHY NOT SUPABASE AUTH
 *
 *   Supabase Auth would hand the browser an `authenticated` JWT. Every table in
 *   this schema has RLS enabled with zero policies (D11), so that token can read
 *   nothing — it would be a credential that exists only to be ignored. All it
 *   would actually buy is the redirect dance below, at the cost of a second place
 *   (the Supabase dashboard) where the Google client secret lives.
 *
 *   `.env.local.example` has reserved GOOGLE_OAUTH_CLIENT_ID/SECRET for Phase 4
 *   since Phase 1, which is the same conclusion reached earlier. See D44.
 *
 * The client secret never leaves the server: the browser only ever sees the
 * authorization redirect, and the code-for-token exchange is a server-to-server
 * POST. CLAUDE.md hard rule 7.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

export interface GoogleOAuthConfig {
  readonly clientId: string
  readonly clientSecret: string
  /** Must match a redirect URI registered on the OAuth client, character for character. */
  readonly redirectUri: string
}

export interface GoogleIdentity {
  readonly email: string
  readonly emailVerified: boolean
  readonly name: string | null
  readonly subject: string
}

export class GoogleAuthError extends Error {
  /** Operator-facing. Never contains a token, a code or the client secret. */
  readonly operatorMessage: string

  constructor(operatorMessage: string, detail?: string) {
    super(detail ? `${operatorMessage} (${detail})` : operatorMessage)
    this.name = 'GoogleAuthError'
    this.operatorMessage = operatorMessage
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function authorizationUrl(
  config: GoogleOAuthConfig,
  params: { state: string; codeVerifier: string },
): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', pkceChallenge(params.codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  // Always offer the account chooser. Without it a signed-out operator is
  // bounced straight back in on whichever Google account the browser last used,
  // which is also what makes "prove an unauthorised account is refused"
  // impossible to demonstrate.
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

/**
 * Reads the identity out of an ID token that we just received from Google's token
 * endpoint over TLS, on a connection we opened.
 *
 * The signature is deliberately not re-verified. Google's own guidance is that a
 * token fetched directly from the token endpoint over HTTPS needs no local
 * signature check — there is no untrusted party in between. Everything that can
 * still be wrong *is* checked: issuer, audience, expiry and email verification.
 * A token arriving by any other route would need JWKS verification, and no such
 * route exists here.
 */
export function readIdentity(
  idToken: string,
  config: GoogleOAuthConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GoogleIdentity {
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    throw new GoogleAuthError('Google returned a sign-in token Loupe could not read.', 'shape')
  }

  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    throw new GoogleAuthError('Google returned a sign-in token Loupe could not read.', 'payload')
  }

  const issuer = typeof claims.iss === 'string' ? claims.iss : ''
  if (!GOOGLE_ISSUERS.has(issuer)) {
    throw new GoogleAuthError('That sign-in did not come from Google.', 'iss')
  }

  const audience = typeof claims.aud === 'string' ? claims.aud : ''
  if (audience !== config.clientId) {
    throw new GoogleAuthError('That sign-in was issued for a different application.', 'aud')
  }

  const expiry = typeof claims.exp === 'number' ? claims.exp : 0
  if (expiry <= nowSeconds) {
    throw new GoogleAuthError('That sign-in took too long and expired. Try again.', 'exp')
  }

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (!email) {
    throw new GoogleAuthError('Google did not share an email address for that account.', 'email')
  }

  const emailVerified = claims.email_verified === true
  if (!emailVerified) {
    throw new GoogleAuthError(
      'That Google account has an unverified email address, so Loupe cannot match it to a user.',
      'email_verified',
    )
  }

  return {
    email,
    emailVerified,
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
    subject: typeof claims.sub === 'string' ? claims.sub : '',
  }
}

export interface TokenExchangeDeps {
  readonly fetchImpl?: typeof fetch
}

export interface OAuthClientCheck {
  readonly ok: boolean
  readonly reason: string
  readonly detail: string
}

/**
 * Is this client id / client secret pair one Google will actually accept?
 *
 * Presence is not validity — the same lesson as `GOOGLE_SERVICE_ACCOUNT_JSON`
 * (D26), and it bites harder here because a WRONG SECRET IS INVISIBLE UNTIL THE
 * LAST STEP. The authorization redirect only uses the client id, so Google shows
 * its own sign-in page, the operator signs in successfully, and the failure
 * arrives at the token exchange as an opaque 401 that reads like an outage.
 *
 * The probe deliberately sends a code that cannot possibly be valid and reads
 * which complaint comes back:
 *
 *   400 invalid_grant   the credentials were ACCEPTED and only the code was
 *                       rejected — which is the answer we want
 *   401 invalid_client  the id/secret pair is not a client Google recognises
 *
 * It creates nothing, consumes nothing and cannot sign anybody in.
 */
export async function checkGoogleOAuthClient(
  config: GoogleOAuthConfig,
  deps: TokenExchangeDeps = {},
): Promise<OAuthClientCheck> {
  const doFetch = deps.fetchImpl ?? fetch

  if (!config.clientId.endsWith('.apps.googleusercontent.com')) {
    return {
      ok: false,
      reason: 'not a Google client id',
      detail:
        'GOOGLE_OAUTH_CLIENT_ID should end with .apps.googleusercontent.com. Copy it from the OAuth client, not from a service account.',
    }
  }

  let response: Response
  try {
    response = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'loupe-health-probe-not-a-real-code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
  } catch (cause) {
    return {
      ok: false,
      reason: 'Google unreachable',
      detail: cause instanceof Error ? cause.message : 'network error',
    }
  }

  const body = (await response.json().catch(() => ({}))) as { error?: unknown }
  const error = typeof body.error === 'string' ? body.error : `http ${response.status}`

  if (error === 'invalid_grant') {
    return { ok: true, reason: 'accepted', detail: 'Google accepted the client id and secret.' }
  }
  if (error === 'invalid_client' || response.status === 401) {
    return {
      ok: false,
      reason: 'client id / secret rejected',
      detail:
        'Google returned invalid_client. The secret does not belong to this client id — or the ' +
        'OAuth client is not of type "Web application", which is the only type that has one. ' +
        'Create a Web application client and set both values from the same client.',
    }
  }
  if (error === 'redirect_uri_mismatch') {
    return {
      ok: false,
      reason: 'redirect URI not registered',
      detail: `Add ${config.redirectUri} to the OAuth client's Authorised redirect URIs, exactly, with no trailing slash.`,
    }
  }
  return { ok: false, reason: error, detail: `Google refused the probe with "${error}".` }
}

/** Exchanges the one-time code for an ID token. Server-to-server; secret stays here. */
export async function exchangeCodeForIdentity(
  config: GoogleOAuthConfig,
  params: { code: string; codeVerifier: string },
  deps: TokenExchangeDeps = {},
): Promise<GoogleIdentity> {
  const doFetch = deps.fetchImpl ?? fetch

  let response: Response
  try {
    response = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: params.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: params.codeVerifier,
      }).toString(),
    })
  } catch (cause) {
    throw new GoogleAuthError(
      'Loupe could not reach Google to complete the sign-in. Check the connection and try again.',
      cause instanceof Error ? cause.message : 'network',
    )
  }

  if (!response.ok) {
    // The body can echo request parameters back. Keep it out of anything shown
    // or logged; the status is enough to tell misconfiguration from an outage.
    throw new GoogleAuthError(
      'Google refused to complete the sign-in. If this keeps happening the OAuth client or its redirect URI is misconfigured.',
      `http ${response.status}`,
    )
  }

  let body: { id_token?: unknown }
  try {
    body = (await response.json()) as { id_token?: unknown }
  } catch {
    throw new GoogleAuthError('Google returned an unreadable response to the sign-in.', 'json')
  }

  if (typeof body.id_token !== 'string' || !body.id_token) {
    throw new GoogleAuthError('Google completed the sign-in without returning an identity.', 'id_token')
  }

  return readIdentity(body.id_token, config)
}
