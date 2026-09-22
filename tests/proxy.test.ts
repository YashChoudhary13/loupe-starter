import { getRedirectUrl } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

afterEach(() => { delete process.env.FACE_DEV })
const at = (url: string, extra: Record<string, string> = {}) => new NextRequest(url, { headers: { host: new URL(url).host, ...extra } })

describe('proxy', () => {
  it('sends a wrong-host screen to its owner with the same path and query, 307', () => {
    const response = proxy(at('https://qc.qimati-eng.site/console?x=1'))
    expect(response.status).toBe(307)
    expect(getRedirectUrl(response)).toBe('https://loupe.qimati-eng.site/console?x=1')
  })
  it("sends / to the face's first screen", () => { expect(getRedirectUrl(proxy(at('https://ship.qimati-eng.site/')))).toBe('https://ship.qimati-eng.site/dispatch') })
  it("lets the api, sign-in, health and the face's own screens through with x-face set", () => {
    for (const path of ['/api/qc/1', '/login', '/health', '/qc/123']) {
      const response = proxy(at(`https://qc.qimati-eng.site${path}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('x-middleware-request-x-face')).toBe('qc')
    }
  })
  it('never trusts an x-face header sent by the client', () => {
    expect(proxy(at('https://qc.qimati-eng.site/qc', { 'x-face': 'home' })).headers.get('x-middleware-request-x-face')).toBe('qc')
  })
  it('on a dev machine without FACE_DEV every screen is allowed and no face is set', () => {
    const response = proxy(at('http://localhost:3000/dispatch'))
    expect(response.status).toBe(200); expect(response.headers.get('x-middleware-request-x-face')).toBeNull()
  })
  it('with FACE_DEV a dev machine wears one face', () => {
    process.env.FACE_DEV = 'home'
    expect(getRedirectUrl(proxy(at('http://localhost:3000/dispatch')))).toBe('https://ship.qimati-eng.site/dispatch')
    expect(getRedirectUrl(proxy(at('http://localhost:3000/')))).toBe('http://localhost:3000/home')
  })
  it('skips static assets', () => { expect(config.matcher[0]).toContain('_next/static') })
})
