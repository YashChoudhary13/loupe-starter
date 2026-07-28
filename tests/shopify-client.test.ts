/**
 * The GraphQL client's retry behaviour — the other half of success criterion 5.
 *
 * The token manager proves the token gets refreshed on a schedule. This proves the
 * unscheduled case: Shopify says 401 even though our cached expiry says the token
 * is fine. Clocks drift and tokens get revoked, so the expiry is a prediction, and
 * the only correct response to a 401 is to throw the token away, mint a new one and
 * try once more.
 *
 * "Once" is load-bearing. Retrying a 401 in a loop against an app whose scopes are
 * wrong turns a clear failure into a slow one, and hard rule 4 says retries are
 * bounded and then a human looks.
 */
import { describe, expect, it } from 'vitest'

import { ShopifyClient } from '@/lib/shopify/client'
import type { ShopifyConfig } from '@/lib/shopify/config'
import { ShopifyError } from '@/lib/shopify/errors'
import { ShopifyTokenManager } from '@/lib/shopify/token'

const CONFIG: ShopifyConfig = {
  storeDomain: 'qimti.myshopify.com',
  clientId: 'test-client-id',
  clientSecret: 'shpss_test-secret',
  apiVersion: '2026-07',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface Recorded {
  url: string
  token?: string
}

/**
 * Wires a token manager and a client onto one scripted fetch, so the test can see
 * token requests and GraphQL requests interleaved in the order they really happen.
 */
function harness(graphqlResponses: (() => Response)[]) {
  const seen: Recorded[] = []
  let tokenSerial = 0
  let graphqlCall = 0

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url: href, token: headers['X-Shopify-Access-Token'] })

    if (href.endsWith('/admin/oauth/access_token')) {
      tokenSerial += 1
      return json({ access_token: `shpua_${tokenSerial}`, expires_in: 86_399 })
    }

    const next = graphqlResponses[graphqlCall] ?? graphqlResponses[graphqlResponses.length - 1]
    graphqlCall += 1
    return next()
  }) as unknown as typeof fetch

  const tokens = new ShopifyTokenManager({ config: CONFIG, fetchImpl, now: () => 1 })
  const client = new ShopifyClient({
    config: CONFIG,
    tokens,
    fetchImpl,
    // No real waiting in tests; the delays themselves are not what is under test.
    sleep: async () => {},
  })

  return {
    client,
    tokens,
    seen,
    tokenRequests: () => seen.filter((s) => s.url.endsWith('/access_token')).length,
    graphqlRequests: () => seen.filter((s) => s.url.includes('/graphql.json')).length,
  }
}

describe('ShopifyClient', () => {
  it('attaches the token and returns data', async () => {
    const h = harness([() => json({ data: { shop: { name: 'Qimati' } } })])

    await expect(h.client.graphql('{ shop { name } }')).resolves.toEqual({
      shop: { name: 'Qimati' },
    })
    expect(h.seen.at(-1)?.token).toBe('shpua_1')
  })

  it('on 401: invalidates, mints a NEW token and retries once', async () => {
    const h = harness([
      () => new Response('unauthorized', { status: 401 }),
      () => json({ data: { ok: true } }),
    ])

    await expect(h.client.graphql('{ ok }')).resolves.toEqual({ ok: true })

    expect(h.tokenRequests()).toBe(2) // the original mint, then the forced refresh
    expect(h.graphqlRequests()).toBe(2)

    const graphqlCalls = h.seen.filter((s) => s.url.includes('/graphql.json'))
    expect(graphqlCalls[0].token).toBe('shpua_1')
    expect(graphqlCalls[1].token).toBe('shpua_2') // a genuinely different token
  })

  it('on a second 401 it gives up rather than looping', async () => {
    const h = harness([() => new Response('unauthorized', { status: 401 })])

    await expect(h.client.graphql('{ ok }')).rejects.toMatchObject({
      kind: 'unauthorized',
      retryable: false,
    })
    // Exactly two attempts. Not three, not forever.
    expect(h.graphqlRequests()).toBe(2)
  })

  it('retries a 429 with bounded backoff, then succeeds', async () => {
    const h = harness([
      () => new Response('slow down', { status: 429 }),
      () => new Response('slow down', { status: 429 }),
      () => json({ data: { ok: true } }),
    ])

    await expect(h.client.graphql('{ ok }')).resolves.toEqual({ ok: true })
    expect(h.graphqlRequests()).toBe(3)
  })

  it('treats a 200 carrying a THROTTLED extension as a rate limit, not a success', async () => {
    // Shopify answers a throttled GraphQL call with HTTP 200. Checking res.ok is
    // not enough, and missing this loses a product that would have gone out.
    const h = harness([
      () =>
        json({
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        }),
      () => json({ data: { ok: true } }),
    ])

    await expect(h.client.graphql('{ ok }')).resolves.toEqual({ ok: true })
    expect(h.graphqlRequests()).toBe(2)
  })

  it('stops after the retry budget instead of retrying forever', async () => {
    const h = harness([() => new Response('boom', { status: 503 })])

    const error = await h.client.graphql('{ ok }').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ShopifyError)
    expect((error as ShopifyError).retryable).toBe(false) // budget spent — a human looks
    expect(h.graphqlRequests()).toBe(4) // DEFAULT_RETRY_DELAYS_MS.length
  })

  it('does not retry a permanent GraphQL error', async () => {
    const h = harness([
      () => json({ errors: [{ message: "Field 'nope' doesn't exist" }] }),
      () => json({ data: { ok: true } }),
    ])

    await expect(h.client.graphql('{ nope }')).rejects.toMatchObject({
      kind: 'graphql',
      retryable: false,
    })
    expect(h.graphqlRequests()).toBe(1)
  })
})
