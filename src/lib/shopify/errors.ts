/**
 * Shopify failures, classified.
 *
 * CLAUDE.md hard rule 4 splits errors into *retryable* (429, 5xx, timeout,
 * network) and *permanent* (bad input, a refusal, a validation error). The split
 * has to be made where the error is created, because by the time it reaches a
 * retry loop the HTTP status is long gone.
 *
 * Getting this backwards is expensive in both directions: retrying a permanent
 * error burns the retry budget and delays a human looking at it, and giving up on
 * a transient 429 loses a product that would have published on the next attempt.
 */
export type ShopifyErrorKind =
  | 'auth' // token could not be minted, or the app is not installed
  | 'unauthorized' // a 401 on an API call — the token needs refreshing
  | 'throttled' // 429, or a GraphQL THROTTLED extension
  | 'server' // 5xx
  | 'network' // fetch itself threw
  | 'graphql' // top-level `errors` in an otherwise-200 response
  | 'user_error' // `userErrors` from a mutation — our input was wrong
  | 'malformed' // a 200 whose body is not the shape we asked for

export interface ShopifyErrorInit {
  readonly kind: ShopifyErrorKind
  readonly retryable: boolean
  readonly status?: number
  readonly detail?: unknown
  readonly hint?: string
}

export class ShopifyError extends Error {
  readonly kind: ShopifyErrorKind
  readonly retryable: boolean
  readonly status?: number
  readonly detail?: unknown
  readonly hint?: string

  constructor(message: string, init: ShopifyErrorInit) {
    super(init.hint ? `${message}\n  → ${init.hint}` : message)
    this.name = 'ShopifyError'
    this.kind = init.kind
    this.retryable = init.retryable
    this.status = init.status
    this.detail = init.detail
    this.hint = init.hint
  }
}

/** True for the statuses worth trying again: rate limits and server faults. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}
