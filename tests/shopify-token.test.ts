/**
 * Phase 2 · success criterion 5 — the token refresh path is proven, not assumed.
 *
 * This is the test the phase prompt singled out, and the reason is worth keeping
 * written down: a token manager that fetches once at boot passes every
 * happy-path test today and silently stops publishing tomorrow. The failure has a
 * 24-hour fuse, so it cannot be caught by running the suite.
 *
 * So the clock is injected. Every assertion below moves time forward by hours and
 * asserts on `stats().fetches` — the number of times the token endpoint was
 * ACTUALLY called. Nothing here waits, and nothing here touches the network.
 */
import { describe, expect, it } from 'vitest'

import type { ShopifyConfig } from '@/lib/shopify/config'
import { ShopifyError } from '@/lib/shopify/errors'
import {
  ASSUMED_EXPIRES_IN_SECONDS,
  DEFAULT_REFRESH_LEAD_MS,
  ShopifyTokenManager,
} from '@/lib/shopify/token'

const CONFIG: ShopifyConfig = {
  storeDomain: 'qimti.myshopify.com',
  clientId: 'test-client-id',
  clientSecret: 'shpss_test-secret',
  apiVersion: '2026-07',
}

const HOUR = 60 * 60 * 1000

/** What Shopify actually returns: an offline token that lasts 86399 seconds. */
function tokenResponse(token: string, expiresIn = 86_399): Response {
  return new Response(
    JSON.stringify({ access_token: token, scope: 'write_products', expires_in: expiresIn }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

interface Harness {
  manager: ShopifyTokenManager
  advance: (ms: number) => void
  calls: () => number
  bodies: () => Record<string, unknown>[]
}

function harness(responses: (() => Response)[] | (() => Response)): Harness {
  let clock = 1_700_000_000_000
  let call = 0
  const bodies: Record<string, unknown>[] = []

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const next = Array.isArray(responses)
      ? (responses[call] ?? responses[responses.length - 1])
      : responses
    call += 1
    return next()
  }) as unknown as typeof fetch

  return {
    manager: new ShopifyTokenManager({ config: CONFIG, fetchImpl, now: () => clock }),
    advance: (ms) => {
      clock += ms
    },
    calls: () => call,
    bodies: () => bodies,
  }
}

describe('ShopifyTokenManager', () => {
  it('sends the client_credentials grant, not a static token', async () => {
    const h = harness(() => tokenResponse('shpua_first'))
    await expect(h.manager.getToken()).resolves.toBe('shpua_first')

    expect(h.bodies()[0]).toEqual({
      grant_type: 'client_credentials',
      client_id: 'test-client-id',
      client_secret: 'shpss_test-secret',
    })
  })

  it('caches: repeated calls inside the window hit the network once', async () => {
    const h = harness(() => tokenResponse('shpua_first'))

    for (let i = 0; i < 5; i += 1) await h.manager.getToken()
    h.advance(HOUR)
    await h.manager.getToken()

    expect(h.calls()).toBe(1)
  })

  it('REFRESHES PROACTIVELY at ~20 h into a 24 h token — the criterion-5 assertion', async () => {
    const h = harness([() => tokenResponse('shpua_first'), () => tokenResponse('shpua_second')])

    expect(await h.manager.getToken()).toBe('shpua_first')
    expect(h.calls()).toBe(1)

    // 19 hours later: still inside the window, still the same token.
    h.advance(19 * HOUR)
    expect(await h.manager.getToken()).toBe('shpua_first')
    expect(h.calls()).toBe(1)

    // 20 h 1 min: past the refresh point but comfortably BEFORE the 24 h expiry.
    // A manager that only refreshed on expiry would still be handing out the old
    // token here — and would be handing out an expired one four hours later.
    h.advance(HOUR + 60_000)
    expect(await h.manager.getToken()).toBe('shpua_second')
    expect(h.calls()).toBe(2)
  })

  it('refreshes an already-expired token — inject one and watch it fetch', async () => {
    const h = harness([() => tokenResponse('shpua_stale'), () => tokenResponse('shpua_fresh')])

    expect(await h.manager.getToken()).toBe('shpua_stale')
    const expiresAt = h.manager.stats().expiresAt
    expect(expiresAt).not.toBeNull()

    // Well past expiry: tomorrow, which is when the naive implementation breaks.
    h.advance(25 * HOUR)
    expect(await h.manager.getToken()).toBe('shpua_fresh')
    expect(h.calls()).toBe(2)
  })

  it('computes the refresh point from the response, not from an assumption', async () => {
    // A ten-minute token. Assuming 24 h here is exactly the silent failure the
    // class exists to prevent.
    const h = harness([() => tokenResponse('shpua_short', 600), () => tokenResponse('shpua_next', 600)])

    await h.manager.getToken()
    const stats = h.manager.stats()
    expect(stats.expiresAt! - stats.refreshAt!).toBe(600_000 - 60_000) // floored at 1 min of life

    h.advance(61_000)
    expect(await h.manager.getToken()).toBe('shpua_next')
    expect(h.calls()).toBe(2)
  })

  it('falls back to the documented 86399 s when Shopify omits expires_in', async () => {
    const h = harness(
      () =>
        new Response(JSON.stringify({ access_token: 'shpua_noexpiry' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    await h.manager.getToken()
    const stats = h.manager.stats()
    const start = stats.expiresAt! - ASSUMED_EXPIRES_IN_SECONDS * 1000
    expect(stats.refreshAt! - start).toBe(ASSUMED_EXPIRES_IN_SECONDS * 1000 - DEFAULT_REFRESH_LEAD_MS)
    // ≈ 20 h into a 24 h token.
    expect(Math.round((stats.refreshAt! - start) / HOUR)).toBe(20)
  })

  it('invalidate() forces the next call to mint — this is the 401 path', async () => {
    const h = harness([() => tokenResponse('shpua_first'), () => tokenResponse('shpua_second')])

    expect(await h.manager.getToken()).toBe('shpua_first')
    h.manager.invalidate()
    expect(await h.manager.getToken()).toBe('shpua_second')
    expect(h.calls()).toBe(2)
  })

  it('collapses concurrent callers onto ONE mint', async () => {
    // Twenty parallel publishes (success criterion 3) must not make twenty token
    // calls: Shopify rate-limits this endpoint.
    let resolveFetch: ((value: Response) => void) | undefined
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    }) as unknown as typeof fetch

    const manager = new ShopifyTokenManager({ config: CONFIG, fetchImpl, now: () => 1 })
    const all = Promise.all(Array.from({ length: 20 }, () => manager.getToken()))

    await Promise.resolve()
    expect(calls).toBe(1)

    resolveFetch!(tokenResponse('shpua_shared'))
    expect(await all).toEqual(Array.from({ length: 20 }, () => 'shpua_shared'))
    expect(calls).toBe(1)
  })

  it('a failed mint does not poison the manager', async () => {
    const h = harness([
      () => new Response('nope', { status: 503 }),
      () => tokenResponse('shpua_recovered'),
    ])

    await expect(h.manager.getToken()).rejects.toThrow(ShopifyError)
    expect(await h.manager.getToken()).toBe('shpua_recovered')
  })

  it('explains app_not_installed instead of reporting a bare 400', async () => {
    const h = harness(
      () =>
        new Response('<html><head><title>400 - Oauth error app_not_installed</title></head></html>', {
          status: 400,
          headers: { 'Content-Type': 'text/html' },
        }),
    )

    await expect(h.manager.getToken()).rejects.toThrow(/not installed on this store/i)
  })

  it('classifies a 5xx as retryable and a bad secret as permanent', async () => {
    const server = harness(() => new Response('boom', { status: 502 }))
    await expect(server.manager.getToken()).rejects.toMatchObject({ retryable: true })

    const bad = harness(() => new Response('<title>401 Unauthorized</title>', { status: 401 }))
    await expect(bad.manager.getToken()).rejects.toMatchObject({ retryable: false })
  })
})
