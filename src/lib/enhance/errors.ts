import { DriveError } from '@/lib/google/drive-errors'

export type EnhancementErrorStage =
  | 'drive'
  | 'input'
  | 'describe'
  | 'image'
  | 'storage'
  | 'database'
  | 'fencing'

export interface EnhancementErrorInit {
  readonly stage: EnhancementErrorStage
  readonly code: string
  readonly retryable: boolean
  readonly detail?: unknown
}

export class EnhancementError extends Error {
  readonly stage: EnhancementErrorStage
  readonly code: string
  readonly retryable: boolean
  readonly detail?: unknown

  constructor(message: string, init: EnhancementErrorInit) {
    super(message)
    this.name = 'EnhancementError'
    this.stage = init.stage
    this.code = init.code
    this.retryable = init.retryable
    this.detail = init.detail
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

export function statusOf(error: unknown): number | undefined {
  const root = record(error)
  if (typeof root?.status === 'number') return root.status
  if (typeof root?.$metadata === 'object') {
    const status = record(root.$metadata)?.httpStatusCode
    if (typeof status === 'number') return status
  }
  const response = record(root?.response)
  return typeof response?.status === 'number' ? response.status : undefined
}

function codeOf(error: unknown): string | undefined {
  const root = record(error)
  if (typeof root?.code === 'string') return root.code
  if (typeof root?.name === 'string') return root.name
  return codeOf(root?.cause)
}

const NETWORK_CODES = new Set([
  'AbortError',
  'TimeoutError',
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

export function classifyWorkerError(error: unknown): EnhancementError {
  if (error instanceof EnhancementError) return error

  if (error instanceof DriveError) {
    return new EnhancementError(error.message, {
      stage: 'drive',
      code: `drive_${error.kind}`,
      retryable: error.retryable,
      detail: error.detail,
    })
  }

  const status = statusOf(error)
  const code = codeOf(error)
  const message = error instanceof Error ? error.message : String(error)
  const network =
    (code !== undefined && NETWORK_CODES.has(code)) ||
    /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|\btimed? ?out\b/i.test(message)

  if (status === 429 || status === 408 || (status !== undefined && status >= 500) || network) {
    return new EnhancementError('The enhancement service is temporarily unavailable.', {
      stage: 'image',
      code:
        status === 429
          ? 'provider_rate_limited'
          : status === 408 || /timed? ?out/i.test(message)
            ? 'provider_timeout'
            : 'provider_unavailable',
      retryable: true,
      detail: error,
    })
  }

  return new EnhancementError('The enhancement request could not be completed.', {
    stage: 'image',
    code: 'enhancement_request_failed',
    retryable: false,
    detail: error,
  })
}

export function safeErrorDetail(error: unknown): string {
  const detail =
    error instanceof EnhancementError
      ? error.detail
      : error instanceof DriveError
        ? error.detail
        : error

  try {
    return JSON.stringify(detail ?? null).slice(0, 16_000)
  } catch {
    return String(detail).slice(0, 16_000)
  }
}
