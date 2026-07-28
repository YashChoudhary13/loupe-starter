/**
 * The Shopify Admin GraphQL client.
 *
 * Thin on purpose. It does exactly three things beyond `fetch`:
 *
 *   1. Attaches a token from the ShopifyTokenManager.
 *   2. On **401**, invalidates the token and retries **once**. Once, not in a
 *      loop: if a freshly minted token is also rejected, the problem is the app's
 *      scopes or its installation, and retrying just turns a clear failure into a
 *      slow one.
 *   3. On 429 / 5xx / a `THROTTLED` GraphQL extension, retries with bounded
 *      backoff. Bounded — CLAUDE.md hard rule 4. This is the short, interactive
 *      backoff for a request a person is waiting on, NOT the enhancement worker's
 *      0/1m/5m/20m/1h schedule, which is for a background job.
 *
 * GraphQL's habit of returning HTTP 200 with an `errors` array means checking
 * `res.ok` is not enough; both layers are checked here so no caller has to remember.
 */
import { type ShopifyConfig, graphqlEndpoint, shopifyConfig } from './config'
import { ShopifyError, isRetryableStatus } from './errors'
import { ShopifyTokenManager } from './token'

/** 0 s, 1 s, 3 s, 8 s. Four attempts, then a human looks. */
export const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 3_000, 8_000] as const

interface GraphqlErrorShape {
  message?: string
  extensions?: { code?: string; [k: string]: unknown }
  path?: readonly (string | number)[]
}

interface GraphqlEnvelope<T> {
  data?: T
  errors?: readonly GraphqlErrorShape[]
  extensions?: { cost?: unknown }
}

export interface ShopifyClientOptions {
  readonly config?: ShopifyConfig
  readonly tokens?: ShopifyTokenManager
  readonly fetchImpl?: typeof fetch
  readonly retryDelaysMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
}

export class ShopifyClient {
  readonly config: ShopifyConfig
  readonly tokens: ShopifyTokenManager

  private readonly fetchImpl: typeof fetch
  private readonly retryDelaysMs: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>

  private requestCount = 0

  constructor(options: ShopifyClientOptions = {}) {
    this.config = options.config ?? shopifyConfig()
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.tokens =
      options.tokens ?? new ShopifyTokenManager({ config: this.config, fetchImpl: this.fetchImpl })
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /** Number of HTTP calls made to the GraphQL endpoint, retries included. */
  get requests(): number {
    return this.requestCount
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: ShopifyError | undefined

    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      const delay = this.retryDelaysMs[attempt] ?? 0
      if (delay > 0) await this.sleep(delay)

      try {
        return await this.attempt<T>(query, variables, true)
      } catch (error) {
        if (!(error instanceof ShopifyError) || !error.retryable) throw error
        lastError = error
      }
    }

    throw new ShopifyError(
      `Shopify did not answer after ${this.retryDelaysMs.length} attempts: ${lastError?.message ?? 'unknown'}`,
      {
        kind: lastError?.kind ?? 'network',
        // Not retryable any more — the budget is spent and a human should look
        // (hard rule 4). Never infinite.
        retryable: false,
        status: lastError?.status,
        detail: lastError?.detail,
      },
    )
  }

  private async attempt<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    mayRetryUnauthorized: boolean,
  ): Promise<T> {
    const token = await this.tokens.getToken()
    this.requestCount += 1

    let res: Response
    try {
      res = await this.fetchImpl(graphqlEndpoint(this.config), {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      })
    } catch (cause) {
      throw new ShopifyError(`Could not reach ${graphqlEndpoint(this.config)}.`, {
        kind: 'network',
        retryable: true,
        detail: cause,
      })
    }

    if (res.status === 401) {
      // The expiry we cached was a prediction. Shopify disagrees; Shopify wins.
      this.tokens.invalidate()
      if (mayRetryUnauthorized) return this.attempt<T>(query, variables, false)
      throw new ShopifyError(
        'Shopify rejected a freshly minted access token (401).',
        {
          kind: 'unauthorized',
          retryable: false,
          status: 401,
          hint:
            'The token is new, so this is not expiry. Check that the app is still installed on ' +
            `${this.config.storeDomain} and that it has the scopes this call needs (write_products, ` +
            'read_locations, write_inventory).',
        },
      )
    }

    const body = await res.text()

    if (!res.ok) {
      throw new ShopifyError(`Shopify Admin API returned HTTP ${res.status}.`, {
        kind: res.status === 429 ? 'throttled' : res.status >= 500 ? 'server' : 'graphql',
        retryable: isRetryableStatus(res.status),
        status: res.status,
        detail: body.slice(0, 600),
      })
    }

    let envelope: GraphqlEnvelope<T>
    try {
      envelope = JSON.parse(body) as GraphqlEnvelope<T>
    } catch {
      throw new ShopifyError('Shopify returned 200 with a body that is not JSON.', {
        kind: 'malformed',
        retryable: false,
        status: res.status,
        detail: body.slice(0, 400),
      })
    }

    if (envelope.errors?.length) {
      // A 200 that is really a rate limit. Easy to miss, and missing it means
      // giving up on a product that would have gone out a second later.
      const throttled = envelope.errors.some((e) => e.extensions?.code === 'THROTTLED')
      throw new ShopifyError(
        `Shopify GraphQL error: ${envelope.errors.map((e) => e.message ?? '?').join('; ')}`,
        {
          kind: throttled ? 'throttled' : 'graphql',
          retryable: throttled,
          status: res.status,
          detail: envelope.errors,
        },
      )
    }

    if (envelope.data === undefined || envelope.data === null) {
      throw new ShopifyError('Shopify returned neither data nor errors.', {
        kind: 'malformed',
        retryable: false,
        status: res.status,
        detail: body.slice(0, 400),
      })
    }

    return envelope.data
  }
}
