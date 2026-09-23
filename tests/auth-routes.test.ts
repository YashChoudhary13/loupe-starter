import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
const SECRET = 'a'.repeat(64)
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/env', () => ({ serverEnv: { authSessionSecret: 'a'.repeat(64), authBaseUrl: 'https://qimati-eng.site' } }))
vi.mock('@/lib/auth/authorize', () => ({
  currentOperator: async () => null,
  googleOAuthConfig: () => ({ clientId: 'x.apps.googleusercontent.com', clientSecret: 's', redirectUri: 'https://qimati-eng.site/api/auth/google/callback' }),
}))
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }))
import { GET as start } from '@/app/api/auth/google/start/route'
import { POST as signout } from '@/app/api/auth/signout/route'
import { decodeSignedValue, OAUTH_COOKIE } from '@/lib/auth/session'

const startOn = (host: string) => start(new NextRequest(`https://${host}/api/auth/google/start`, { headers: { host } }))
describe('sign-in start', () => {
  it('records the face whose host started the sign-in, in a domain cookie', async () => {
    const response = await startOn('qc.qimati-eng.site')
    expect(response.headers.get('location')).toContain('accounts.google.com')
    const cookie = response.cookies.get(OAUTH_COOKIE)
    expect(cookie?.domain).toBe('.qimati-eng.site')
    expect(decodeSignedValue<{ face?: string }>(SECRET, cookie?.value)?.face).toBe('qc')
  })
  it('records no face for a host outside the platform', async () => {
    const cookie = (await startOn('evil.example')).cookies.get(OAUTH_COOKIE)
    expect(decodeSignedValue<{ face?: string }>(SECRET, cookie?.value)?.face).toBeUndefined()
  })
})
describe('sign-out', () => {
  it('clears the domain cookie and the old host-only cookie, then returns to the home sign-in', async () => {
    const response = await signout()
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('https://qimati-eng.site/login')
    const cookies = response.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith('loupe_session=') && /domain=\.qimati-eng\.site/i.test(c) && /max-age=0/i.test(c))).toBe(true)
    expect(cookies.some(c => c.startsWith('loupe_session=') && !/domain=/i.test(c) && /max-age=0/i.test(c))).toBe(true)
  })
})
