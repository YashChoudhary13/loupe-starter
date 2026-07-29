export type DriveErrorKind =
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server'
  | 'permission'
  | 'not_found'
  | 'request'
  | 'malformed_response'

export interface DriveErrorInit {
  readonly kind: DriveErrorKind
  readonly retryable: boolean
  readonly status?: number
  /** Raw upstream information for server-side diagnostics. Never return this from a route. */
  readonly detail?: unknown
}

/**
 * A safe operator-facing message plus separately-held raw detail.
 *
 * Google errors can contain request metadata. Keeping that material out of
 * `message` prevents a route from accidentally returning it to a caller.
 */
export class DriveError extends Error {
  readonly kind: DriveErrorKind
  readonly retryable: boolean
  readonly status?: number
  readonly detail?: unknown

  constructor(message: string, init: DriveErrorInit) {
    super(message)
    this.name = 'DriveError'
    this.kind = init.kind
    this.retryable = init.retryable
    this.status = init.status
    this.detail = init.detail
  }
}

const NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function statusOf(error: unknown): number | undefined {
  const record = recordOf(error)
  if (!record) return undefined

  if (typeof record.status === 'number') return record.status
  if (typeof record.code === 'number') return record.code

  const response = recordOf(record.response)
  return typeof response?.status === 'number' ? response.status : undefined
}

function codeOf(error: unknown): string | undefined {
  const record = recordOf(error)
  if (!record) return undefined
  if (typeof record.code === 'string') return record.code
  return codeOf(record.cause)
}

function nameOf(error: unknown): string | undefined {
  const record = recordOf(error)
  return typeof record?.name === 'string' ? record.name : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorReasons(error: unknown): readonly string[] {
  const root = recordOf(error)
  const response = recordOf(root?.response)
  const responseData = recordOf(response?.data)
  const responseError = recordOf(responseData?.error)
  const candidates = [
    root?.errors,
    responseData?.errors,
    responseError?.errors,
  ]

  return candidates.flatMap((candidate) => {
    if (!Array.isArray(candidate)) return []
    return candidate
      .map((item) => recordOf(item)?.reason)
      .filter((reason): reason is string => typeof reason === 'string')
  })
}

/**
 * Converts a generated-client/Gaxios failure into Loupe's bounded-retry split.
 *
 * 429, HTTP 408, 5xx, timeouts and known network failures are retryable.
 * Permission and missing-resource failures need configuration or human action.
 */
export function classifyDriveError(error: unknown, operation: string): DriveError {
  if (error instanceof DriveError) return error

  const status = statusOf(error)
  if (status === 429) {
    return new DriveError(`Google Drive rate-limited ${operation}.`, {
      kind: 'rate_limited',
      retryable: true,
      status,
      detail: error,
    })
  }

  if (status === 408) {
    return new DriveError(`Google Drive timed out while ${operation}.`, {
      kind: 'timeout',
      retryable: true,
      status,
      detail: error,
    })
  }

  if (status !== undefined && status >= 500) {
    return new DriveError(`Google Drive is temporarily unavailable while ${operation}.`, {
      kind: 'server',
      retryable: true,
      status,
      detail: error,
    })
  }

  if (status === 403) {
    const reasons = errorReasons(error)
    if (
      reasons.includes('rateLimitExceeded') ||
      reasons.includes('userRateLimitExceeded')
    ) {
      return new DriveError(`Google Drive rate-limited ${operation}.`, {
        kind: 'rate_limited',
        retryable: true,
        status,
        detail: error,
      })
    }

    return new DriveError(
      'Google Drive denied access. Share the RAW folder with the configured service account.',
      {
        kind: 'permission',
        retryable: false,
        status,
        detail: error,
      },
    )
  }

  if (status === 404) {
    return new DriveError(
      'Google Drive could not find the configured RAW folder or change resource.',
      {
        kind: 'not_found',
        retryable: false,
        status,
        detail: error,
      },
    )
  }

  const code = codeOf(error)
  const name = nameOf(error)
  const message = messageOf(error)
  const timeout =
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /\btimeout|timed out\b/i.test(message)

  if (timeout) {
    return new DriveError(`Google Drive timed out while ${operation}.`, {
      kind: 'timeout',
      retryable: true,
      status,
      detail: error,
    })
  }

  if (code !== undefined && NETWORK_CODES.has(code)) {
    return new DriveError(`Could not reach Google Drive while ${operation}.`, {
      kind: 'network',
      retryable: true,
      status,
      detail: error,
    })
  }

  if (
    status === undefined &&
    (name === 'FetchError' ||
      /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|\bgetaddrinfo\b|\bconnection (?:reset|refused)\b/i.test(
        message,
      ))
  ) {
    return new DriveError(`Could not reach Google Drive while ${operation}.`, {
      kind: 'network',
      retryable: true,
      detail: error,
    })
  }

  return new DriveError(`Google Drive rejected the request while ${operation}.`, {
    kind: 'request',
    retryable: false,
    status,
    detail: error,
  })
}
