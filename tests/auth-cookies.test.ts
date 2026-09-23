import { beforeEach, describe, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ authBaseUrl: 'https://qimati-eng.site' }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ serverEnv: { get authBaseUrl() { return env.authBaseUrl } } }))
import { clearedCookieOptions, clearHostOnlyCookieHeader, cookieDomain, sessionCookieOptions, shortLivedCookieOptions } from '@/lib/auth/cookies'

describe('cookie domain', () => {
  beforeEach(() => { env.authBaseUrl = 'https://qimati-eng.site' })
  it('is .qimati-eng.site in production, on every cookie', () => {
    expect(cookieDomain()).toBe('.qimati-eng.site')
    expect(sessionCookieOptions()).toMatchObject({ domain: '.qimati-eng.site', secure: true, httpOnly: true, sameSite: 'lax', path: '/' })
    expect(shortLivedCookieOptions(600)).toMatchObject({ domain: '.qimati-eng.site', maxAge: 600 })
    expect(clearedCookieOptions()).toMatchObject({ domain: '.qimati-eng.site', maxAge: 0 })
  })
  it('is absent on http (dev) and on a host outside the platform domain', () => {
    env.authBaseUrl = 'http://localhost:3000'; expect(cookieDomain()).toBeUndefined(); expect('domain' in sessionCookieOptions()).toBe(false)
    env.authBaseUrl = 'https://loupe.example'; expect(cookieDomain()).toBeUndefined()
  })
  it('can still clear the pre-platform host-only cookie', () => {
    expect(clearHostOnlyCookieHeader('loupe_session')).toBe('loupe_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
    env.authBaseUrl = 'http://localhost:3000'; expect(clearHostOnlyCookieHeader('loupe_session')).toBe('loupe_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
  })
})
