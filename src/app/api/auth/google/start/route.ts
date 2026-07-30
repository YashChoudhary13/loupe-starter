import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { googleOAuthConfig } from '@/lib/auth/authorize'
import { shortLivedCookieOptions } from '@/lib/auth/cookies'
import { authorizationUrl } from '@/lib/auth/google'
import {
  DENIED_COOKIE,
  encodeSignedValue,
  OAUTH_COOKIE,
  randomToken,
} from '@/lib/auth/session'
import { serverEnv } from '@/lib/env'

/** Ten minutes is longer than any real sign-in and shorter than any real absence. */
const HANDSHAKE_TTL_SECONDS = 600

export const dynamic = 'force-dynamic'

/**
 * Step one of Google sign-in: mint the CSRF `state` and the PKCE verifier, keep
 * them in an httpOnly cookie, and send the browser to Google.
 *
 * The verifier stays here rather than travelling with the redirect — that is the
 * whole point of PKCE. An attacker who intercepts the authorization code at the
 * callback still cannot exchange it, because they cannot produce the verifier
 * that hashes to the challenge Google was given.
 */
export async function GET(): Promise<NextResponse> {
  const state = randomToken()
  const codeVerifier = randomToken()

  const response = NextResponse.redirect(
    authorizationUrl(googleOAuthConfig(), { state, codeVerifier }),
  )

  response.cookies.set(
    OAUTH_COOKIE,
    encodeSignedValue(serverEnv.authSessionSecret, { state, codeVerifier }),
    shortLivedCookieOptions(HANDSHAKE_TTL_SECONDS),
  )
  // Starting a new sign-in clears any previous refusal, so the denied screen
  // cannot linger over a successful attempt.
  const jar = await cookies()
  if (jar.get(DENIED_COOKIE)) {
    response.cookies.set(DENIED_COOKIE, '', shortLivedCookieOptions(0))
  }

  return response
}
