import { NextResponse } from 'next/server'

import { currentOperator } from '@/lib/auth/authorize'
import { clearedCookieOptions } from '@/lib/auth/cookies'
import { DENIED_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from '@/lib/auth/session'
import { serverEnv } from '@/lib/env'
import { supabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * POST, not GET. A sign-out link that a page can be made to prefetch is a way to
 * log somebody out by sending them a URL.
 */
export async function POST(): Promise<NextResponse> {
  const operator = await currentOperator()

  const response = NextResponse.redirect(new URL('/login', serverEnv.authBaseUrl), {
    // 303 so the browser follows with GET rather than re-POSTing to /login.
    status: 303,
  })
  response.cookies.set(SESSION_COOKIE, '', clearedCookieOptions())
  response.cookies.set(OAUTH_COOKIE, '', clearedCookieOptions())
  response.cookies.set(DENIED_COOKIE, '', clearedCookieOptions())

  if (operator) {
    await supabaseServer().from('events').insert({
      entity_type: 'app_user',
      entity_id: operator.id,
      event: 'auth.signed_out',
      detail: { email: operator.email },
      actor: operator.email,
    })
  }

  return response
}
