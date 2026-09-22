import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/env', () => ({ serverEnv: { authBaseUrl: 'https://qimati-eng.site/' } }))
import { isOwnOrigin } from '@/lib/faces/server'

describe('own origins', () => {
  it('accepts the base origin and every face host, nothing else', () => {
    for (const origin of ['https://qimati-eng.site', 'https://qc.qimati-eng.site', 'https://ship.qimati-eng.site', 'https://loupe.qimati-eng.site']) expect(isOwnOrigin(origin)).toBe(true)
    for (const origin of ['https://evil.example', 'http://qc.qimati-eng.site', 'https://qc.qimati-eng.site.evil', 'https://qimati-eng.site.evil', null, '']) expect(isOwnOrigin(origin)).toBe(false)
  })
})
