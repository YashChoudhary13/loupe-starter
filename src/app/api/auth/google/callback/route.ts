import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

import { findActiveAppUser, googleOAuthConfig, touchLastSeen } from '@/lib/auth/authorize'
import { clearedCookieOptions, sessionCookieOptions, shortLivedCookieOptions } from '@/lib/auth/cookies'
import { exchangeCodeForIdentity, GoogleAuthError } from '@/lib/auth/google'
import {
  DENIED_COOKIE,
  decodeSignedValue,
  encodeSignedValue,
  issueSession,
  OAUTH_COOKIE,
  SESSION_COOKIE,
} from '@/lib/auth/session'
import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const DENIAL_TTL_SECONDS = 300

interface Handshake {
  state: string
  codeVerifier: string
}

function backToLogin(reason: string): NextResponse {
  const url = new URL('/login', serverEnv.authBaseUrl)
  url.searchParams.set('error', reason)
  return NextResponse.redirect(url)
}

/**
 * Step two: Google sends the browser back with a one-time code.
 *
 * Order matters. The code is exchanged for an identity FIRST, and only then is
 * that identity looked up in `app_users`. A Google account that is not on the
 * allowlist gets a session cookie for nothing — it is never issued one — and
 * never reaches a page that reads application data.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const jar = await cookies()
  const handshake = decodeSignedValue<Handshake>(
    serverEnv.authSessionSecret,
    jar.get(OAUTH_COOKIE)?.value,
  )

  const params = request.nextUrl.searchParams
  if (params.get('error')) {
    // The operator pressed Cancel on Google's own screen, or Google refused.
    return backToLogin('cancelled')
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state || !handshake || handshake.state !== state) {
    return backToLogin('handshake')
  }

  let identity
  try {
    identity = await exchangeCodeForIdentity(googleOAuthConfig(), {
      code,
      codeVerifier: handshake.codeVerifier,
    })
  } catch (cause) {
    if (cause instanceof GoogleAuthError) {
      console.warn(`google sign-in failed: ${cause.message}`)
      return backToLogin('google')
    }
    throw cause
  }

  const operator = await findActiveAppUser(identity.email)

  if (!operator) {
    // Refused. Nothing about the console is rendered, no session is set, and the
    // only thing carried forward is the address the person actually signed in
    // with — in a signed cookie rather than a query string, so it stays out of
    // browser history, logs and any referrer.
    const response = NextResponse.redirect(new URL('/login', serverEnv.authBaseUrl))
    response.cookies.set(
      DENIED_COOKIE,
      encodeSignedValue(serverEnv.authSessionSecret, { email: identity.email }),
      shortLivedCookieOptions(DENIAL_TTL_SECONDS),
    )
    response.cookies.set(OAUTH_COOKIE, '', clearedCookieOptions())

    await supabaseServer().from('events').insert({
      entity_type: 'app_user',
      event: 'auth.denied',
      detail: { email: identity.email, reason: 'not an active app_users row' },
      actor: identity.email,
    })
    return response
  }

  const { value, payload } = issueSession(serverEnv.authSessionSecret, operator)

  const response = NextResponse.redirect(new URL('/console', serverEnv.authBaseUrl))
  response.cookies.set(SESSION_COOKIE, value, sessionCookieOptions())
  response.cookies.set(OAUTH_COOKIE, '', clearedCookieOptions())
  response.cookies.set(DENIED_COOKIE, '', clearedCookieOptions())

  await touchLastSeen(operator.id)
  await supabaseServer().from('events').insert({
    entity_type: 'app_user',
    entity_id: operator.id,
    event: 'auth.signed_in',
    detail: { email: operator.email, role: operator.role, expires_at: payload.exp },
    actor: operator.email,
  })

  return response
}
