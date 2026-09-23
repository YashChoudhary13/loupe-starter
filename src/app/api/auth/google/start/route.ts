import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

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
import { faceOfHost } from '@/lib/faces/faces'

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
 *
 * The face whose host started the sign-in travels in the same signed cookie, so
 * the callback (always on the Home host) can send the operator back where they
 * were.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const state = randomToken()
  const codeVerifier = randomToken()

  const response = NextResponse.redirect(
    authorizationUrl(googleOAuthConfig(), { state, codeVerifier }),
  )

  const face = faceOfHost(request.headers.get('host'))
  response.cookies.set(
    OAUTH_COOKIE,
    encodeSignedValue(serverEnv.authSessionSecret, { state, codeVerifier, ...(face ? { face } : {}) }),
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
