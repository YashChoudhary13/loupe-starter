/**
 * The Shopify access-token manager.
 *
 * Auth is the OAuth **client_credentials** grant, not a static `shpat_` token
 * (CLAUDE.md hard rule 7). `POST /admin/oauth/access_token` with the app's client
 * id and secret returns an offline token that expires in 24 hours:
 *
 *   { "access_token": "shpua_…", "scope": "write_products,…", "expires_in": 86399 }
 *
 * WHY THIS FILE IS MORE THAN A ONE-LINER
 *
 *   The naive version — fetch a token when the module loads, keep it in a
 *   variable — passes every test today, publishes perfectly all afternoon, and
 *   then stops working tomorrow with a 401 that nobody is watching for. A serverless
 *   deploy hides it further: cold starts mint fresh tokens often enough that the
 *   bug only appears on a warm instance that has been alive for a day.
 *
 *   So this manager does four specific things, and each of them is tested:
 *
 *     1. Caches the token WITH its expiry, taken from the response rather than
 *        assumed.
 *     2. Refreshes PROACTIVELY — `refreshLeadMs` before expiry, four hours by
 *        default, so a 24-hour token is replaced at about the 20-hour mark. A
 *        refresh at the moment of expiry would still fail every request that was
 *        already in flight.
 *     3. Treats a 401 as *invalidate, refresh, retry once* rather than as a
 *        failure. Clocks drift and Shopify may revoke early; the expiry is a
 *        prediction, not a guarantee. (The retry lives in `client.ts`; this file
 *        provides `invalidate()`.)
 *     4. Collapses concurrent callers onto ONE in-flight fetch. Publishing 20
 *        products in parallel must not mint 20 tokens — Shopify rate-limits the
 *        token endpoint, and each mint may invalidate the last.
 *
 * `now` and `fetchImpl` are injectable for exactly one reason: the refresh path is
 * the part that matters, and proving it must not require waiting twenty hours.
 * See tests/shopify-token.test.ts.
 */
import { type ShopifyConfig, tokenEndpoint } from './config'
import { ShopifyError, isRetryableStatus } from './errors'

/** Refresh this long before the token expires. 4 h → a 24 h token turns over at ~20 h. */
export const DEFAULT_REFRESH_LEAD_MS = 4 * 60 * 60 * 1000

/** What Shopify says a client_credentials token lasts, if it declines to say. */
export const ASSUMED_EXPIRES_IN_SECONDS = 86_399

export interface ShopifyTokenManagerOptions {
  readonly config: ShopifyConfig
  readonly fetchImpl?: typeof fetch
  /** Milliseconds since the epoch. Injectable so the refresh path is testable. */
  readonly now?: () => number
  readonly refreshLeadMs?: number
}

export interface TokenStats {
  /** How many times the token endpoint has actually been called. */
  readonly fetches: number
  readonly expiresAt: number | null
  readonly refreshAt: number | null
  readonly scope: string | null
}

interface CachedToken {
  readonly token: string
  readonly expiresAt: number
  readonly refreshAt: number
  readonly scope: string | null
}

export class ShopifyTokenManager {
  private readonly config: ShopifyConfig
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly refreshLeadMs: number

  private cached: CachedToken | null = null
  private inFlight: Promise<string> | null = null
  private fetches = 0

  constructor(options: ShopifyTokenManagerOptions) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.refreshLeadMs = options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
  }

  /** A token that is valid now, minting or refreshing one if necessary. */
  async getToken(): Promise<string> {
    const cached = this.cached
    if (cached && this.now() < cached.refreshAt) return cached.token

    // Single-flight. Twenty parallel publishes share one mint.
    this.inFlight ??= this.mint().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * Throws the cached token away. Call this on a 401: the expiry we were given is
   * a prediction, and Shopify is the authority on whether a token still works.
   */
  invalidate(): void {
    this.cached = null
  }

  stats(): TokenStats {
    return {
      fetches: this.fetches,
      expiresAt: this.cached?.expiresAt ?? null,
      refreshAt: this.cached?.refreshAt ?? null,
      scope: this.cached?.scope ?? null,
    }
  }

  private async mint(): Promise<string> {
    const requestedAt = this.now()
    this.fetches += 1

    let res: Response
    try {
      res = await this.fetchImpl(tokenEndpoint(this.config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      })
    } catch (cause) {
      throw new ShopifyError(
        `Could not reach the Shopify token endpoint for ${this.config.storeDomain}.`,
        { kind: 'network', retryable: true, detail: cause },
      )
    }

    const body = await res.text()

    if (!res.ok) throw this.tokenFailure(res.status, body)

    let parsed: { access_token?: unknown; expires_in?: unknown; scope?: unknown }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      throw new ShopifyError(
        `The Shopify token endpoint returned ${res.status} with a body that is not JSON.`,
        { kind: 'malformed', retryable: false, status: res.status, detail: body.slice(0, 400) },
      )
    }

    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new ShopifyError('The Shopify token response carried no access_token.', {
        kind: 'malformed',
        retryable: false,
        status: res.status,
        detail: Object.keys(parsed),
      })
    }

    // Trust the response's expiry when it gives one. Assuming 24 h against a token
    // Shopify says lasts 10 minutes is precisely the silent-failure this class exists
    // to prevent.
    const expiresInMs =
      (typeof parsed.expires_in === 'number' && parsed.expires_in > 0
        ? parsed.expires_in
        : ASSUMED_EXPIRES_IN_SECONDS) * 1000

    // Floor of one minute so an unexpectedly short token still gets used rather than
    // being refreshed on every single call.
    const lifetimeBeforeRefresh = Math.max(60_000, expiresInMs - this.refreshLeadMs)

    this.cached = {
      token: parsed.access_token,
      expiresAt: requestedAt + expiresInMs,
      refreshAt: requestedAt + lifetimeBeforeRefresh,
      scope: typeof parsed.scope === 'string' ? parsed.scope : null,
    }

    return parsed.access_token
  }

  private tokenFailure(status: number, body: string): ShopifyError {
    // Shopify answers this endpoint with an HTML error page, not JSON, so the
    // useful signal is in the <title>. Surfacing it matters: `app_not_installed`
    // is by far the most likely first-run failure and is not obvious from a bare 400.
    const title = /<title>([^<]+)<\/title>/.exec(body)?.[1]?.trim()
    const summary = title ?? body.slice(0, 200)

    if (/app_not_installed/i.test(body)) {
      return new ShopifyError(
        `Shopify refused to mint a token for ${this.config.storeDomain}: the app is not installed on this store.`,
        {
          kind: 'auth',
          retryable: false,
          status,
          detail: summary,
          hint:
            `The client_credentials grant only works once the app is installed. Open the app's ` +
            `install link from the Shopify admin (Settings → Apps and sales channels), or run ` +
            `\`shopify app deploy\` and install it on ${this.config.storeDomain}. ` +
            `SHOPIFY_CLIENT_ID must belong to that installed app.`,
        },
      )
    }

    return new ShopifyError(
      `Shopify refused to mint a token for ${this.config.storeDomain} (HTTP ${status}): ${summary}`,
      {
        kind: 'auth',
        retryable: isRetryableStatus(status),
        status,
        detail: summary,
        hint:
          status === 401 || status === 400
            ? 'Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET against the app in the Shopify admin.'
            : undefined,
      },
    )
  }
}
