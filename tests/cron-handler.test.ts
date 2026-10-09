import { describe, expect, it, vi } from 'vitest'

import { createCronPostHandler } from '@/lib/cron/handler'
import { validatedCronSecret } from '@/lib/cron/secret'

function request(headers: HeadersInit = {}): Request {
  return new Request('https://loupe.example.com/api/cron/retention', {
    method: 'POST',
    headers,
  })
}

const VALID_SECRET_HEADERS: readonly HeadersInit[] = [
  { authorization: 'Bearer correct-secret' },
  { 'x-cron-secret': 'correct-secret' },
]

describe('cron POST authentication', () => {
  it('accepts exactly 32 random bytes encoded as hex', () => {
    expect(validatedCronSecret('A1'.repeat(32))).toBe('A1'.repeat(32))
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['not hex', 'z'.repeat(64)],
  ])('rejects a %s cron credential', (_label, value) => {
    expect(() => validatedCronSecret(value)).toThrow(/32 random bytes/)
  })

  it.each([
    ['missing header', {}],
    ['wrong bearer', { authorization: 'Bearer wrong' }],
    ['wrong alternate header', { 'x-cron-secret': 'wrong' }],
  ])('returns 401 for %s and never starts the job', async (_label, headers) => {
    const run = vi.fn(async () => ({ inserted: 1 }))
    const post = createCronPostHandler({
      expectedSecret: () => 'correct-secret',
      run,
    })

    const response = await post(request(headers))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Unauthorized',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('fails closed with 401 when CRON_SECRET configuration is missing', async () => {
    const run = vi.fn(async () => ({ inserted: 1 }))
    const post = createCronPostHandler({
      expectedSecret: () => {
        throw new Error('missing CRON_SECRET')
      },
      run,
    })

    expect((await post(request({ authorization: 'Bearer anything' }))).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it.each(VALID_SECRET_HEADERS)('accepts either supported secret header', async (headers) => {
    const post = createCronPostHandler({
      expectedSecret: () => 'correct-secret',
      run: async () => ({ inserted: 2 }),
    })

    const response = await post(request(headers))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, inserted: 2 })
  })

  it('returns a generic failure, never raw upstream detail', async () => {
    const post = createCronPostHandler({
      expectedSecret: () => 'correct-secret',
      run: async () => {
        throw new Error('upstream said: Bearer must-not-leak')
      },
    })

    const response = await post(request({ authorization: 'Bearer correct-secret' }))
    expect(response.status).toBe(500)
    const body = JSON.stringify(await response.json())
    expect(body).toContain('Cron job failed')
    expect(body).not.toContain('must-not-leak')
  })
})
