import { describe, expect, it } from 'vitest'
import { FACES, faceForHost, faceFromHeader, faceHome, faceOfHost, faceOrigins, faceReturnUrl, faceRoute, owningFace, screenAllowed } from '@/lib/faces/faces'

const prod = { production: true }
describe('faces by host', () => {
  it.each([['qimati-eng.site', 'home'], ['loupe.qimati-eng.site', 'loupe'], ['qc.qimati-eng.site', 'qc'], ['ship.qimati-eng.site', 'ship'], ['QC.qimati-eng.site:443', 'qc']])('%s is %s', (host, face) => {
    expect(faceOfHost(host)).toBe(face); expect(faceForHost(host, prod)).toBe(face)
  })
  it('an unknown host is Loupe in production and unrestricted on a dev machine', () => {
    expect(faceForHost('203.0.113.9', prod)).toBe('loupe'); expect(faceForHost(null, prod)).toBe('loupe')
    expect(faceForHost('localhost:3000', { production: false })).toBeNull()
  })
  it('FACE_DEV picks a face on a dev machine but never overrides a real host', () => {
    expect(faceForHost('localhost:3000', { production: false, dev: 'home' })).toBe('home')
    expect(faceForHost('localhost:3000', { production: false, dev: 'nope' })).toBeNull()
    expect(faceForHost('qc.qimati-eng.site', { production: false, dev: 'home' })).toBe('qc')
    expect(faceForHost('203.0.113.9', { production: true, dev: 'ship' })).toBe('loupe')
  })
  it('reads the proxy header and nothing else', () => { expect(faceFromHeader('ship')).toBe('ship'); expect(faceFromHeader('evil')).toBeNull(); expect(faceFromHeader(null)).toBeNull(); expect(faceFromHeader('constructor')).toBeNull(); expect(faceFromHeader('__proto__')).toBeNull() })
})
describe('screens', () => {
  it("allows only the face's own screens, plus the api, sign-in, health and assets", () => {
    expect(screenAllowed('qc', '/qc')).toBe(true); expect(screenAllowed('qc', '/qc/123')).toBe(true); expect(screenAllowed('qc', '/qc/shortages')).toBe(true); expect(screenAllowed('qc', '/labels')).toBe(true)
    expect(screenAllowed('qc', '/console')).toBe(false); expect(screenAllowed('qc', '/qcx')).toBe(false); expect(screenAllowed('ship', '/qc')).toBe(false); expect(screenAllowed('home', '/dispatch')).toBe(false)
    for (const path of ['/api/qc/1', '/login', '/health', '/_next/static/x.js', '/favicon.ico']) expect(screenAllowed('home', path)).toBe(true)
    expect(screenAllowed(null, '/dispatch')).toBe(true)
  })
  it("knows each screen's owner, each face's first screen and every origin", () => {
    expect(owningFace('/dispatch')).toBe('ship'); expect(owningFace('/console/drafts/1')).toBe('loupe'); expect(owningFace('/nope')).toBeNull()
    expect(faceHome('home')).toBe('/home'); expect(faceHome('qc')).toBe('/qc'); expect(faceHome(null)).toBe('/console')
    expect(faceOrigins()).toEqual(['https://qimati-eng.site', 'https://loupe.qimati-eng.site', 'https://qc.qimati-eng.site', 'https://ship.qimati-eng.site'])
    expect(new Set(Object.values(FACES).map(face => face.host)).size).toBe(4)
  })
})
describe('routing one request', () => {
  it("sends / to the face's first screen, absolute on a real host and relative elsewhere", () => {
    expect(faceRoute({ host: 'qc.qimati-eng.site', pathname: '/', production: true })).toEqual({ face: 'qc', redirect: 'https://qc.qimati-eng.site/qc' })
    expect(faceRoute({ host: 'localhost:3000', pathname: '/', production: false })).toEqual({ face: null, redirect: '/console' })
    expect(faceRoute({ host: 'localhost:3000', pathname: '/', production: false, dev: 'home' })).toEqual({ face: 'home', redirect: '/home' })
    expect(faceRoute({ host: '127.0.0.1:3000', pathname: '/', production: true })).toEqual({ face: 'loupe', redirect: 'https://loupe.qimati-eng.site/console' })
  })
  it("sends another face's screen to that face, keeps its own, and leaves unknown paths to 404", () => {
    expect(faceRoute({ host: 'qc.qimati-eng.site', pathname: '/console/drafts/1', production: true })).toEqual({ face: 'qc', redirect: 'https://loupe.qimati-eng.site/console/drafts/1' })
    expect(faceRoute({ host: 'ship.qimati-eng.site', pathname: '/dispatch', production: true })).toEqual({ face: 'ship', redirect: null })
    expect(faceRoute({ host: 'qimati-eng.site', pathname: '/api/home/chat', production: true })).toEqual({ face: 'home', redirect: null })
    expect(faceRoute({ host: 'qimati-eng.site', pathname: '/nope', production: true })).toEqual({ face: 'home', redirect: null })
    expect(faceRoute({ host: '203.0.113.9', pathname: '/home', production: true })).toEqual({ face: 'loupe', redirect: 'https://qimati-eng.site/home' })
  })
  it('returns a finished sign-in to the recorded face host, else to the configured base', () => {
    expect(faceReturnUrl('qc', 'https://qimati-eng.site')).toBe('https://qc.qimati-eng.site/')
    expect(faceReturnUrl('evil.example', 'https://qimati-eng.site/')).toBe('https://qimati-eng.site/')
    expect(faceReturnUrl(undefined, 'http://localhost:3000')).toBe('http://localhost:3000/')
  })
})
